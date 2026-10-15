/**
 * The deployer Worker. Exports: the default handlers (queue consumer; fetch answers 404), the
 * `Deployer` RPC entrypoint the authorizer binds to, the `Coordinator` Durable Object (one per
 * application and environment), and the runner's `RunnerJob` Durable Object and `EgressGate`.
 */
import { handlers } from './entry.ts';

export { Deployer } from './entry.ts';
export { Coordinator } from './coordinator/durable-object.ts';
export { RunnerJob, EgressGate } from './runner/platform.ts';

export default handlers;
