export declare function securityTxtFields(text: string): Map<string, string>
export declare function checkSecurityTxt(
  text: string,
  now?: number,
): { errors: string[]; warnings: string[] }
