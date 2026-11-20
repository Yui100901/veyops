import { shellQuote } from '../pipelines/pipeline.validation';

export const gitCredentialHelper = (responsePath: string) =>
  `!f() { case "$1" in get) cat -- ${shellQuote(responsePath)} ;; store|erase) : ;; *) return 1 ;; esac; }; f`;
