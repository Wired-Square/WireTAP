// ui/src/i18n.ts
//
// i18next bootstrap. Imported once from main.tsx for side effects so the
// instance is initialised before any component renders.
//
// The active language is driven by the user's `language` setting (see
// settingsStore.general.language). App.tsx watches that setting and calls
// i18n.changeLanguage() whenever it changes.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { FALLBACK_LANGUAGE, NAMESPACES, resources } from './locales';

void i18n.use(initReactI18next).init({
  resources,
  lng: FALLBACK_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  ns: [...NAMESPACES],
  defaultNS: 'common',
  interpolation: {
    // React already escapes interpolated values.
    escapeValue: false,
  },
  returnNull: false,
});

export default i18n;
