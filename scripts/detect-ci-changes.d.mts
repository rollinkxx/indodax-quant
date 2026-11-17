export type CiChangeFlags = {
  deploy: boolean;
  relay: boolean;
  strategy: boolean;
};

export function classifyCiChanges(
  eventName: string,
  baseSha: string | undefined,
  changedFiles?: string[],
): CiChangeFlags;
