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
import enAUDecoder from './en-AU/decoder.json';
import enAUTestPattern from './en-AU/testPattern.json';
import enAUAnalysis from './en-AU/analysis.json';
import enAUDevices from './en-AU/devices.json';
import enAUQuery from './en-AU/query.json';
import enAURules from './en-AU/rules.json';
import enAUCatalog from './en-AU/catalog.json';
import enAUDashboard from './en-AU/dashboard.json';
import enAUSessionManager from './en-AU/sessionManager.json';
import enAUSerial from './en-AU/serial.json';
import enAUEvents from './en-AU/events.json';
import enAUReports from './en-AU/reports.json';

export const FALLBACK_LANGUAGE = 'en-AU';

export const SUPPORTED_LANGUAGES = ['en-AU'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** en-AU wrapped in ⟦…⟧ by `npm run gen:pseudo`, for spotting untranslated text; dev builds only. */
export const PSEUDO_LANGUAGE = 'xx-PS';

export const PICKER_LANGUAGES: readonly string[] = import.meta.env.DEV
  ? [...SUPPORTED_LANGUAGES, PSEUDO_LANGUAGE]
  : SUPPORTED_LANGUAGES;

export const NAMESPACES = ['common', 'settings', 'menus', 'dialogs', 'calculator', 'transmit', 'discovery', 'decoder', 'testPattern', 'analysis', 'devices', 'query', 'rules', 'catalog', 'dashboard', 'sessionManager', 'serial', 'events', 'reports'] as const;
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
    decoder: enAUDecoder,
    testPattern: enAUTestPattern,
    analysis: enAUAnalysis,
    devices: enAUDevices,
    query: enAUQuery,
    rules: enAURules,
    catalog: enAUCatalog,
    dashboard: enAUDashboard,
    sessionManager: enAUSessionManager,
    serial: enAUSerial,
    events: enAUEvents,
    reports: enAUReports,
  },
  ...(import.meta.env.DEV && { [PSEUDO_LANGUAGE]: pseudoResources() }),
} as const;

function pseudoResources() {
  const files = import.meta.glob<object>('./xx-PS/*.json', { eager: true, import: 'default' });
  return Object.fromEntries(Object.entries(files).map(([file, tree]) => [file.slice('./xx-PS/'.length, -'.json'.length), tree]));
}
