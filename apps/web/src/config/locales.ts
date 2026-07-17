export const APP_CONFIG = {
  name: "TuGPT.ai",
  description: "Tu empleado con IA para WhatsApp, llamadas y clientes.",
  primaryLocale: "es" as const,
  secondaryLocale: "en" as const,
  supportedLocales: ["es", "en"] as const,
};

export type SupportedLocale = (typeof APP_CONFIG.supportedLocales)[number];
