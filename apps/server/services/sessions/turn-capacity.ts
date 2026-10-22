/** One daemon owns provider turns. Waiting does not claim durable instructions. */
export class TurnCapacity {
  private active = 0;
  private stopped = false;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number = Infinity) {
    if (!(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0))) {
      throw new Error("Concurrent turn limit must be a positive integer");
    }
  }

  get full() { return this.active >= this.limit || this.waiting.length > 0; }

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(enter);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(new Error("Waiting turn cancelled"));
      };
      const enter = () => {
        signal.removeEventListener("abort", abort);
        if (this.stopped || signal.aborted) { reject(new Error("Waiting turn cancelled")); return; }
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.shift()?.();
        });
      };
      if (signal.aborted || this.stopped) { reject(new Error("Waiting turn cancelled")); return; }
      if (!this.full) enter();
      else {
        this.waiting.push(enter);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  stop() {
    this.stopped = true;
    for (const enter of this.waiting.splice(0)) enter();
  }
}
