import { spawn } from 'node:child_process';

import { Inject, Injectable } from '@nestjs/common';
import { Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { LOGGER } from '../config/tokens';

/**
 * The Compose compiler, from the control server's side.
 *
 * Compose is parsed by a small Go program built into this image, not by the
 * server and not on the hosts being managed. This is the boundary between the
 * two: it starts the process, hands it the request, bounds what it may do, and
 * refuses anything it cannot make sense of.
 *
 * The request carries the values of somebody's secrets, which decides almost
 * everything about how the process is started. It goes on standard input and
 * nowhere else — not a command line, which every process on the machine can
 * read; not the environment, which children inherit; not a temporary file,
 * which outlives the process that wrote it. The child is given an environment
 * of its own rather than this server's, so a compiler that was somehow made to
 * misbehave has no database password to find.
 *
 * The compiler is Dockplane's own code, and it is still treated as a process
 * boundary: its answer is parsed, version-checked and validated like anything
 * else arriving from outside.
 */
@Injectable()
export class ComposeCompilerService {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  /**
   * Compiles a Compose file into a deployment plan.
   *
   * Fails closed in every direction: a compiler that cannot be started, exits
   * badly, answers with something unexpected, runs too long or says too much
   * produces a refusal rather than a plan.
   */
  async compile(request: CompileRequest): Promise<CompileResult> {
    const started = Date.now();
    const answer = await this.run(
      JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...request }),
    );

    const parsed = responseSchema.safeParse(answer);

    if (!parsed.success) {
      this.logger.error(
        { event: 'compose_compiler_protocol_violation' },
        'the Compose compiler answered with something this build does not understand',
      );

      throw new AppError('COMPOSE_COMPILER_FAILED', 'The Compose file could not be compiled.', 500);
    }

    this.logger.info(
      {
        event: 'compose_compiled',
        // The project name is the operator's own word for the stack. Nothing
        // else from the request is logged, because everything else is either
        // the Compose file or the values in it.
        projectName: request.projectName,
        ok: parsed.data.ok,
        problems: parsed.data.errors?.length ?? 0,
        durationMs: Date.now() - started,
      },
      'a Compose file was compiled',
    );

    return parsed.data.ok
      ? { ok: true, plan: parsed.data.plan! }
      : { ok: false, problems: parsed.data.errors ?? [] };
  }

  /**
   * Runs the compiler once.
   *
   * Never through a shell. `spawn` with an argument list and no shell means
   * there is no string for anything in the request to be interpolated into —
   * and the request is a Compose file somebody uploaded.
   */
  private run(payload: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(compilerPath(), [], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        /*
         * Its own environment, not this server's.
         *
         * Node passes `process.env` to a child by default, which here would
         * hand a Compose parser the database URL and the encryption key. It
         * needs none of them: everything it works on arrives on stdin.
         */
        env: { PATH: '/usr/bin:/bin' },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (outcome: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        outcome();
      };

      /*
       * A compiler that never finishes must not hold a request open forever.
       * The child is killed and the operation refused; nothing is deployed on
       * the strength of a compile that did not complete.
       */
      const timer = setTimeout(() => {
        this.logger.warn(
          { event: 'compose_compiler_timeout', timeoutMs: TIMEOUT_MS },
          'the Compose compiler was stopped for taking too long',
        );

        finish(() =>
          reject(
            AppError.conflict(
              'COMPOSE_COMPILER_FAILED',
              'Compiling the Compose file took too long and was stopped.',
            ),
          ),
        );
      }, TIMEOUT_MS);

      timer.unref?.();

      child.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.error(
          { event: 'compose_compiler_unavailable', reason: error.code ?? 'unknown' },
          'the Compose compiler could not be started',
        );

        finish(() =>
          reject(
            new AppError(
              'COMPOSE_COMPILER_UNAVAILABLE',
              'This Dockplane build cannot compile Compose files.',
              500,
            ),
          ),
        );
      });

      // Output is bounded too. A hostile Compose file must not be able to make
      // the compiler fill this server's memory with its answer.
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');

        if (stdout.length > MAX_OUTPUT_BYTES) {
          finish(() =>
            reject(
              AppError.conflict(
                'COMPOSE_COMPILER_FAILED',
                'The Compose file produced more output than Dockplane accepts.',
              ),
            ),
          );
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');

        if (stderr.length > MAX_OUTPUT_BYTES) {
          finish(() =>
            reject(
              AppError.conflict('COMPOSE_COMPILER_FAILED', 'The Compose compiler said too much.'),
            ),
          );
        }
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          /*
           * A rejected Compose file exits zero and says so in its answer, so a
           * non-zero exit is the compiler itself failing. Its diagnostics are
           * deliberately not included here: the process was handed an
           * environment, and a message quoting what it choked on could quote a
           * value from it.
           */
          this.logger.error(
            { event: 'compose_compiler_failed', exitCode: code, diagnostics: stderr.length },
            'the Compose compiler exited without an answer',
          );

          reject(
            new AppError('COMPOSE_COMPILER_FAILED', 'The Compose file could not be compiled.', 500),
          );

          return;
        }

        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(
            new AppError('COMPOSE_COMPILER_FAILED', 'The Compose file could not be compiled.', 500),
          );
        }
      });

      child.stdin.on('error', () => undefined);
      child.stdin.end(payload);
    });
  }
}

/** The protocol this build speaks to the compiler. */
export const PROTOCOL_VERSION = 1;

/**
 * Where the compiler is.
 *
 * A fixed location in the image, never anything a request could influence: a
 * path chosen by a caller would be a way to have this server run something
 * else. It comes from the deployment's own configuration so that a test can
 * point at the binary it just built, and is read per call rather than captured
 * at import — a value frozen at module load is one nothing can change
 * afterwards, including whatever is supposed to.
 */
export function compilerPath(): string {
  return process.env.DOCKPLANE_COMPOSE_COMPILER ?? '/usr/local/bin/dockplane-compose-compiler';
}

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 << 20;

export interface CompileRequest {
  readonly projectName: string;
  readonly compose: string;
  /** Resolved values, secrets included. Never logged, never stored. */
  readonly environment: Readonly<Record<string, string>>;
}

/** One reason a Compose file was not accepted. */
export interface CompileProblem {
  readonly path?: string;
  readonly code: string;
  readonly message: string;
}

export type CompileResult =
  | { readonly ok: true; readonly plan: StackDeploymentPlan }
  | { readonly ok: false; readonly problems: readonly CompileProblem[] };

/**
 * The plan, as this build understands it.
 *
 * Validated rather than trusted. The compiler is Dockplane's own code in
 * Dockplane's own image, and it is still a separate process whose output
 * crosses a boundary — a plan from a build that does not match this one is
 * refused rather than partly understood.
 */
const planSchema = z.object({
  planVersion: z.literal(PROTOCOL_VERSION),
  projectName: z.string(),
  services: z.array(
    z.object({
      serviceName: z.string(),
      containerName: z.string().optional(),
      image: z.string(),
      hostname: z.string().optional(),
      command: z.array(z.string()).optional(),
      entrypoint: z.array(z.string()).optional(),
      environment: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      ports: z
        .array(
          z.object({
            containerPort: z.number().int(),
            hostPort: z.number().int().optional(),
            protocol: z.enum(['tcp', 'udp']),
            hostIp: z.string().optional(),
          }),
        )
        .optional(),
      mounts: z
        .array(
          z.object({
            type: z.enum(['volume', 'bind']),
            source: z.string(),
            target: z.string(),
            readOnly: z.boolean().optional(),
          }),
        )
        .optional(),
      networks: z.array(z.string()).optional(),
      restartPolicy: z.string(),
      labels: z.record(z.string(), z.string()).optional(),
      healthcheck: z
        .object({
          test: z.array(z.string()),
          intervalMs: z.number().optional(),
          timeoutMs: z.number().optional(),
          startPeriodMs: z.number().optional(),
          retries: z.number().optional(),
          disabled: z.boolean().optional(),
        })
        .optional(),
      dependsOn: z.array(z.string()).optional(),
    }),
  ),
  networks: z.array(
    z.object({
      name: z.string(),
      dockerName: z.string().optional(),
      external: z.boolean(),
      driver: z.string().optional(),
    }),
  ),
  volumes: z.array(
    z.object({
      name: z.string(),
      dockerName: z.string().optional(),
      external: z.boolean(),
      driver: z.string().optional(),
    }),
  ),
});

export type StackDeploymentPlan = z.infer<typeof planSchema>;

const responseSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    ok: z.boolean(),
    plan: planSchema.optional(),
    errors: z
      .array(
        z.object({
          path: z.string().optional(),
          code: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .refine((response) => (response.ok ? response.plan !== undefined : true), {
    message: 'a successful answer has to carry a plan',
  });
