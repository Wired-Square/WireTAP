// ui/src/locales/index.ts
//
// Locale registry. Each locale is a record of namespace -> translation tree.
// To add a new language, drop a folder alongside `en-AU/` containing the same
// JSON namespaces, import them here, and add the entry to `resources`.

import enAUCommon from './en-AU/common.json';
import enAUSettings from './en-AU/settings.json';
import enAUMenus from './en-AU/menus.json';
import enAUDialogs from './en-AU/dialogs.json';
import enAUCalculator from './en-AU/calculator.json';
import enAUTransmit from './en-AU/transmit.json';
import enAUDiscovery from './en-AU/discovery.json';

export const FALLBACK_LANGUAGE = 'en-AU';

export const SUPPORTED_LANGUAGES = ['en-AU'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const NAMESPACES = ['common', 'settings', 'menus', 'dialogs', 'calculator', 'transmit', 'discovery'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const resources = {
  'en-AU': {
    common: enAUCommon,
    settings: enAUSettings,
    menus: enAUMenus,
    dialogs: enAUDialogs,
    calculator: enAUCalculator,
    transmit: enAUTransmit,
    discovery: enAUDiscovery,
  },
} as const;
