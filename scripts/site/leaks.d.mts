export declare function machineSecrets(extra?: string[]): string[]
export declare function findLeaks(text: string, secrets?: string[]): string[]
export declare function assertNoLeaks(text: string, secrets: string[], what: string): void
