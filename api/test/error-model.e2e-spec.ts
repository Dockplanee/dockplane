import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, resetThrottling } from './app';

/*
The shape of an error a client actually receives.

Every failure leaves the control server as a code, a sentence and a request
identifier. The code is what a client branches on, so it has to describe what
went wrong rather than borrow the name of an unrelated resource, and nothing
about the server's internals may travel with it.
*/
describe('the error model', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
  });

  beforeEach(() => {
    resetThrottling(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /*
   * An address that does not exist is not a resource that has gone missing.
   * Answering a misspelled URL with a host error would tell an operator that a
   * machine had disappeared from their estate.
   */
  it('answers an unknown route with a code about the route', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/no-such-thing').expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.body.message).toBe('The requested resource does not exist.');
    expect(response.body.requestId).toEqual(expect.any(String));
  });

  it('carries a request identifier a client can quote back', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/no-such-thing').expect(404);

    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  it('never returns a stack trace or an internal field to a client', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/no-such-thing').expect(404);

    expect(Object.keys(response.body).sort()).toEqual(['code', 'message', 'requestId']);
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  /*
   * Health probes answer outside the versioned API. A load balancer configured
   * against them must not start failing because the API took a new version.
   */
  it('serves the liveness probe outside the versioned API', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
