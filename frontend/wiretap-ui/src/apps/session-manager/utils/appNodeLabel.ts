import type { TFunction } from "i18next";

export const appNodeLabel = (t: TFunction<"sessionManager">, appName: string, appId: string): string =>
  appName === "mcp" ? t("node.app.mcpAgent") : appId;
