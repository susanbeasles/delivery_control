/**
 * A job failure with a stable code. `uncertain` marks failures after a mutation may have started
 * (only `tofu apply`): the runner then locks the stack for a human instead of reporting `failed`.
 */
export class JobFailure extends Error {
  /** @param {string} code @param {string} message @param {{ uncertain?: boolean }} [options] */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.uncertain = options.uncertain === true;
  }
}

export const fail = (code, message, options) => {
  throw new JobFailure(code, message, options);
};
