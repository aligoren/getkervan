export declare function securityTxtFields(text: string): Map<string, string>
export declare function checkSecurityTxt(
  text: string,
  now?: number,
): { errors: string[]; warnings: string[] }
export declare function exitCode(
  result: { errors: string[]; warnings: string[] },
  strict: boolean,
): 0 | 1
