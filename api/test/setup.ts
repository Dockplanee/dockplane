import { TestAgentConnection } from './agent-client';

// Keeps certificate and Argon2 work from tripping the default timeout.
jest.setTimeout(30_000);

/*
 * No gateway connection outlives the test that opened it.
 *
 * The server keeps polling an agent for as long as its connection is open. A
 * test that forgets to close one leaves that polling running against data the
 * next test has already cleared, and the work competes with everything that
 * follows — the kind of interference that shows up as an unrelated suite
 * timing out rather than as a failure where it was caused.
 */
afterEach(() => {
  TestAgentConnection.closeAll();
});
