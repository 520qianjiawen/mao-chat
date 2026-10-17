import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import the two always-available languages: English (legacy fallback) and
// Simplified Chinese (the default UI language, preloaded so first paint is
// never an English flash while a bundle loads).
import enTranslation from './en/translation.json';
import zhCnTranslation from './zh_CN/translation.json';

// Cache for loaded translations
const translationCache: Record<string, any> = {
  en: enTranslation,
  zh_CN: zhCnTranslation,
};

// Lazy loaders for all other languages
const translationLoaders: Record<string, () => Promise<any>> = {
  ja: () => import('./ja/translation.json'),
  zh_CN: () => import('./zh_CN/translation.json'),
  zh_TW: () => import('./zh_TW/translation.json'),
  fr: () => import('./fr/translation.json'),
  es: () => import('./es/translation.json'),
  de: () => import('./de/translation.json'),
  ko: () => import('./ko/translation.json'),
  pt_BR: () => import('./pt_BR/translation.json'),
  pt_PT: () => import('./pt_PT/translation.json'),
  id: () => import('./id/translation.json'),
  it: () => import('./it/translation.json'),
  hi: () => import('./hi/translation.json'),
  fi: () => import('./fi/translation.json'),
  fil: () => import('./fil/translation.json'),
  sv: () => import('./sv/translation.json'),
  ru: () => import('./ru/translation.json'),
  ta: () => import('./ta/translation.json'),
  te: () => import('./te/translation.json'),
  th: () => import('./th/translation.json'),
  tr: () => import('./tr/translation.json'),
  uk: () => import('./uk/translation.json'),
  vi: () => import('./vi/translation.json'),
  bn: () => import('./bn/translation.json'),
  fa: () => import('./fa/translation.json'),
  nl: () => import('./nl/translation.json'),
  pl: () => import('./pl/translation.json'),
  ms: () => import('./ms/translation.json'),
  he: () => import('./he/translation.json'),
  ar: () => import('./ar/translation.json'),
};

// Only preload English and Simplified Chinese (the default UI language)
const resources = {
  en: {
    translation: enTranslation,
  },
  zh_CN: {
    translation: zhCnTranslation,
  },
};

// Function to load a translation on demand
export async function loadTranslation(languageCode: string): Promise<void> {
  // Skip if already loaded
  if (translationCache[languageCode]) {
    // Re-add the resource bundle to ensure it's available
    // The last two parameters (true, true) mean: deep merge and overwrite
    i18n.addResourceBundle(languageCode, 'translation', translationCache[languageCode], true, true);
    return;
  }

  // Load the translation
  const loader = translationLoaders[languageCode];
  if (loader) {
    try {
      console.log(`[Sokuji] Loading translation for ${languageCode}...`);
      const startTime = performance.now();
      
      const module = await loader();
      const translation = module.default || module;
      
      // Cache the translation
      translationCache[languageCode] = translation;
      
      // Add to i18n resources with deep merge and overwrite
      i18n.addResourceBundle(languageCode, 'translation', translation, true, true);
      
      const endTime = performance.now();
      console.log(`[Sokuji] Loaded ${languageCode} translation in ${Math.round(endTime - startTime)}ms`);
    } catch (error) {
      console.error(`[Sokuji] Failed to load translation for ${languageCode}:`, error);
    }
  }
}

/** Browser/settings codes like zh-CN must match catalog ids like zh_CN. */
export function normalizeUiLanguage(lng: string | undefined | null): string {
  if (!lng) return 'en';
  const lower = String(lng).replace(/_/g, '-').toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-hans') || lower === 'zh-cn') return 'zh_CN';
  if (lower.startsWith('zh-hant') || lower === 'zh-tw' || lower === 'zh-hk') return 'zh_TW';
  if (lower === 'pt-br') return 'pt_BR';
  if (lower === 'pt-pt') return 'pt_PT';
  const underscored = String(lng).replace('-', '_');
  return (translationLoaders[underscored] || underscored === 'en') ? underscored : 'en';
}

// Wrapper function to change language with translation loading
export async function changeLanguageWithLoad(lng: string): Promise<string> {
  const normalized = normalizeUiLanguage(lng);
  // Load the translation first if it's not English
  if (normalized && normalized !== 'en') {
    await loadTranslation(normalized);
  }

  // Now change the language - this will trigger re-renders
  await i18n.changeLanguage(normalized);

  return normalized;
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // Default UI language: Simplified Chinese. Only an explicit user choice
    // (persisted by the detector's localStorage cache) overrides it — a
    // fresh install always opens in Chinese.
    fallbackLng: 'zh_CN',
    debug: false, // Disable debug mode to reduce startup overhead

    interpolation: {
      escapeValue: false, // React already does escaping
    },

    detection: {
      // localStorage only: the system locale must not override the Chinese
      // default — first-run opens in Chinese unless the user picked a
      // language in Settings or onboarding (both persist here).
      order: ['localStorage'],
      caches: ['localStorage'],
      convertDetectedLanguage: normalizeUiLanguage,
    },
    
    react: {
      useSuspense: false,
    },
    
    // Don't preload any languages except the fallback
    preload: false,
    
    // Support country-specific language codes
    load: 'all', // Allow country-specific variations like zh_CN, pt_BR
    cleanCode: false, // Don't clean country codes from language codes
    
    // Explicitly list all supported languages
    supportedLngs: ['en', 'ja', 'zh_CN', 'zh_TW', 'fr', 'es', 'de', 'ko', 
                    'pt_BR', 'pt_PT', 'id', 'it', 'hi', 'fi', 'fil', 'sv', 
                    'ru', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'bn', 'fa', 
                    'nl', 'pl', 'ms', 'he', 'ar'],
    
    keySeparator: '.', // Use dot notation for nested keys
    
    // Return the key if translation is missing (no network calls)
    missingKeyHandler: false,
  });

// Listen for language changes and load translations on demand
i18n.on('languageChanged', async (lng) => {
  if (lng && lng !== 'en') {
    await loadTranslation(lng);
  }
});

// Load the detected language immediately after init (non-blocking)
const detectedLang = i18n.language;
if (detectedLang && detectedLang !== 'en') {
  // Load in the background without blocking startup
  setTimeout(() => {
    loadTranslation(detectedLang).catch(console.error);
  }, 0);
}

export default i18n;