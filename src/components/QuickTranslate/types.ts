export interface TranslationServiceDefinition {
  id: string;
  name: string;
  badge: string;
  description: string;
  isFree: boolean;
  requiresKey: boolean;
  keyName?: 'zhipuApiKey' | 'siliconFlowApiKey' | 'deeplApiKey';
  defaultModel?: string;
  keyHelpUrl?: string;
}

export const ALL_TRANSLATION_SERVICES: TranslationServiceDefinition[] = [
  {
    id: 'apple-system',
    name: '系统翻译',
    badge: '内置 · 离线',
    description: 'macOS 系统级内置 Apple Translate 翻译引擎，完全免 Key、零流量消耗',
    isFree: true,
    requiresKey: false,
  },
  {
    id: 'zhipu',
    name: '智谱翻译',
    badge: 'GLM-4-Flash · 免费',
    description: '智谱 AI 开放平台 GLM-4-Flash 极速翻译，地道通顺、官方永久免费调用',
    isFree: true,
    requiresKey: true,
    keyName: 'zhipuApiKey',
    defaultModel: 'glm-4-flash',
    keyHelpUrl: 'https://bigmodel.cn/',
  },
  {
    id: 'siliconflow',
    name: '硅基流动翻译',
    badge: 'Qwen2.5-7B · 极速',
    description: '硅基流动开源模型极速托管，内置免费 Qwen 2.5 系列模型，高并发毫秒级响应',
    isFree: true,
    requiresKey: true,
    keyName: 'siliconFlowApiKey',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    keyHelpUrl: 'https://cloud.siliconflow.cn/',
  },
  {
    id: 'bing',
    name: 'Bing 翻译',
    badge: '在线 · 免配置',
    description: '微软必应在线机翻，开箱即用，无需配置 API Key',
    isFree: true,
    requiresKey: false,
  },
  {
    id: 'google',
    name: 'Google 翻译',
    badge: '在线 · 免配置',
    description: '谷歌在线翻译，覆盖全球海量语言对',
    isFree: true,
    requiresKey: false,
  },
  {
    id: 'deepl',
    name: 'DeepL 翻译',
    badge: '高精度 · 需 Key',
    description: '高精度神经机翻，支持 DeepL Free (:fx) 与 Pro API Key',
    isFree: false,
    requiresKey: true,
    keyName: 'deeplApiKey',
    keyHelpUrl: 'https://www.deepl.com/pro-api',
  },
];

export const DEFAULT_ENABLED_SERVICE_IDS = ['apple-system', 'zhipu', 'siliconflow', 'bing'];

export interface ServiceTranslationState {
  serviceId: string;
  isTranslating: boolean;
  translatedText: string;
  latencyMs?: number;
  error?: string | null;
  errorCode?: string | null;
  isCollapsed?: boolean;
}
