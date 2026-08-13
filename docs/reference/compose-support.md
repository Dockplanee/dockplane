# Compose Support

Dockplane reads Compose files with the Compose specification's own library and
turns them into a typed deployment plan. Everything a Compose file can express
that Dockplane does not deploy is refused rather than ignored: a file that asks
for something unsupported is an error, not a deployment quietly missing part of
what its author configured.

Compose is read in one place — the control server — and never on a managed host.
The agent receives a resolved plan and has no Compose parser, no YAML of its
own, and no Docker Compose CLI. There is no shell anywhere in the path.

**Stacks cannot be deployed yet.** This build can read and check a Compose file
and say what it would create. Creating and running stacks comes later.

## Supported

| Area | Supported |
| --- | --- |
| Services | `image`, `container_name`, `hostname`, `command`, `entrypoint` |
| Environment | `environment`, with variable interpolation and defaults |
| Ports | `ports`, with host address, host port, container port and protocol |
| Storage | `volumes` as named volumes and host paths, read-only supported |
| Networks | service `networks`, top-level `networks` |
| Ordering | `depends_on`, as ordering only |
| Runtime | `restart`, `labels`, `healthcheck` |
| Top level | `services`, `volumes`, `networks` |

Variables are resolved by the Compose specification's own rules: `${VAR}`,
`${VAR:-default}` and `$$` for a literal dollar all behave as they do in Docker
Compose. A variable a service needs and nobody supplied is an error rather than
an empty string — a container that starts without a value its author listed
fails later and somewhere harder to look at.

## Not supported

Each of these is refused with the path in the file, a code and a sentence
saying why.

| Feature | Why |
| --- | --- |
| `build` | Dockplane deploys images; it does not build them. Use a pre-built image. |
| `deploy` | Replicas and placement are not implemented. |
| `configs`, `secrets` | Compose's own file-based mechanisms. Set values as stack environment variables instead. |
| `include`, `extends` | Both read other files. A stack is one Compose file. |
| `develop` | A development-time feature with no deployment meaning. |
| `privileged`, `cap_add`, `cap_drop` | Security boundaries Dockplane does not cross for any container. |
| `devices` | The same. |
| `pid`, `ipc` | Sharing a host namespace is not offered. |
| `network_mode` | Attach the service to a network instead. |
| `runtime`, `sysctls`, `group_add` | Not modelled. |
| Port ranges | A range publishes several ports; nothing expands one yet, so it would publish the first and drop the rest. |
| `depends_on` conditions other than `service_started` | Dockplane starts dependencies in order. It cannot wait for a health check, so it will not accept a file that asks it to. |
| Network and volume `driver_opts` | Not applied, so not accepted. |
| Scaling above one container per service | Not implemented. |

Labels beginning `io.dockplane.` are refused. Dockplane sets those itself, and
they are how it recognises the containers it built.

Bind mounts of the Docker socket, `/proc`, `/sys`, `/dev`, the root filesystem
and Dockplane's own state are refused, as they are for a container described by
hand. The agent refuses them again on the host.

`x-` extension fields are accepted and carry no meaning: they do not become part
of what is deployed and cannot change what is.

## Limits

| Limit | Value |
| --- | --- |
| Compose file | 64 KiB |
| Environment variables | 512 |
| Variable name | 256 bytes |
| Variable value | 32 KiB |
| Services | 100 |
| Networks | 50 |
| Volumes | 100 |

## Secrets while compiling

Resolving a Compose file needs the values of its variables, so the compiler is
given them — including the ones marked secret. They travel on the compiler's
standard input and nowhere else: not on a command line, which every process on
the machine can read; not in an environment, which child processes inherit; and
not in a temporary file, which outlives the process that wrote it.

What comes back from checking a Compose file is what it would create — service
names, images, variable *names*, networks and volumes. No value is echoed, and
nothing is stored.
