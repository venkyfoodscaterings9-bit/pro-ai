import type { CustomModel, CustomProvider, ModelOption, ProviderId } from "../types";
import { getModel, PROVIDERS } from "./providers";

export interface ChatModelOption extends ModelOption {
  modelId: string;
  streaming: boolean;
  maxTokens?: number;
  temperature?: number;
  custom: boolean;
}

export function isCustomProvider(providerId: ProviderId, providers: CustomProvider[]): boolean {
  return providers.some((provider) => provider.id === providerId);
}

export function getProviderName(providerId: ProviderId, providers: CustomProvider[]): string {
  return providers.find((provider) => provider.id === providerId)?.name
    ?? PROVIDERS.find((provider) => provider.id === providerId)?.name
    ?? providerId;
}

export function getProviderColor(providerId: ProviderId, providers: CustomProvider[]): string {
  return PROVIDERS.find((provider) => provider.id === providerId)?.color
    ?? (isCustomProvider(providerId, providers) ? "#8976bd" : "#8990a4");
}

export function getChatModel(
  providerId: ProviderId,
  modelId: string,
  providers: CustomProvider[],
): ChatModelOption {
  const customProvider = providers.find((provider) => provider.id === providerId);
  if (customProvider) {
    const model = customProvider.models.find((item) => item.modelId === modelId);
    if (!model) throw new Error(`The selected model is not listed for ${customProvider.name}.`);
    return customModelOption(customProvider, model);
  }
  const model = getModel(providerId, modelId);
  return { ...model, modelId: model.id, streaming: true, custom: false };
}

function customModelOption(provider: CustomProvider, model: CustomModel): ChatModelOption {
  return {
    id: model.modelId,
    modelId: model.modelId,
    name: model.displayName,
    provider: provider.id,
    vision: model.vision,
    streaming: model.streaming,
    maxTokens: model.maxTokens,
    temperature: model.temperature,
    custom: true,
  };
}

export function getSelectableModelGroups(providers: CustomProvider[]): Array<{
  id: ProviderId;
  name: string;
  models: ChatModelOption[];
}> {
  const builtIn = PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: provider.models.map((model) => ({
      ...model,
      modelId: model.id,
      streaming: true,
      custom: false,
    })),
  }));
  const custom = providers.filter((provider) => provider.enabled).map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: provider.models
      .filter((model) => model.enabled)
      .map((model) => customModelOption(provider, model)),
  })).filter((group) => group.models.length);
  return [...builtIn, ...custom];
}
