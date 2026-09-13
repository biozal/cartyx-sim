/** A rules violation that can be reported back to a model, e.g. "no spell slot left". */
export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesError';
  }
}
