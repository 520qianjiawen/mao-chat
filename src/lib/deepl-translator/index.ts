export {
  DeepLTranslatorClient,
  DeepLTranslateError,
  DeepLUnsupportedLanguageError,
  DeepLAuthError,
  isDeepLFreeAuthKey,
  resolveDeepLBaseUrl,
  createDeepLAwareFetch,
  splitForDeepL,
} from './DeepLTranslatorClient';
export type {
  DeepLTranslateResult,
  DeepLTranslatorClientOptions,
} from './DeepLTranslatorClient';
export {
  mapToDeepLSourceCode,
  mapToDeepLTargetCode,
  isSupportedByDeepL,
  DEEPL_SUPPORTED_LANGUAGES,
} from './languageMap';
