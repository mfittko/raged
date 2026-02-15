interface LoggerOptions {
  quiet?: boolean;
  json?: boolean;
}

class Logger {
  private options: LoggerOptions;

  constructor(options: LoggerOptions = {}) {
    this.options = options;
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.options.quiet) return;
    
    if (this.options.json) {
      console.log(JSON.stringify({ level: "info", message, ...data }));
    } else {
      console.log(message);
      if (data) {
        console.dir(data, { depth: null, colors: true });
      }
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.options.quiet) return;
    
    if (this.options.json) {
      console.warn(JSON.stringify({ level: "warn", message, ...data }));
    } else {
      console.warn(message);
      if (data) {
        console.dir(data, { depth: null, colors: true });
      }
    }
  }

  /**
   * Log an error message. Errors are always displayed regardless of quiet mode
   * to ensure critical issues are not silently ignored.
   */
  error(message: string, error?: unknown): void {
    if (this.options.json) {
      const errorData = error instanceof Error ? { error: error.message, stack: error.stack } : { error };
      console.error(JSON.stringify({ level: "error", message, ...errorData }));
    } else {
      console.error(message);
      if (error) {
        if (error instanceof Error) {
          console.error(error);
        } else {
          // Use console.dir for non-Error objects to preserve structure
          console.dir(error, { depth: null, colors: true });
        }
      }
    }
  }

  setOptions(options: LoggerOptions): void {
    this.options = { ...this.options, ...options };
  }
}

export const logger = new Logger();
