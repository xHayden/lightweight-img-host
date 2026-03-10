declare global {
  namespace Express {
    interface Request {
      fileValidationError?: string;
    }
  }
}

export {};
