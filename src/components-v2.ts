import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";

export interface ComponentsV2Options {
  accentColor?: number;
}

function buildTextContainer(text: string, options?: ComponentsV2Options): ContainerBuilder {
  const container = new ContainerBuilder();
  if (options?.accentColor !== undefined) {
    container.setAccentColor(options.accentColor);
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return container;
}

export function textToComponentsV2(text: string, options?: ComponentsV2Options): MessageCreateOptions {
  return {
    components: [buildTextContainer(text, options)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function textToComponentsV2Edit(text: string, options?: ComponentsV2Options): MessageEditOptions {
  return {
    components: [buildTextContainer(text, options)],
  };
}

export function mediaGalleryToComponentsV2(imageUrls: string[], options?: ComponentsV2Options): MessageCreateOptions {
  if (imageUrls.length === 0) {
    return { components: [], flags: MessageFlags.IsComponentsV2 };
  }
  const gallery = new MediaGalleryBuilder();
  for (const url of imageUrls) {
    gallery.addItems(new MediaGalleryItemBuilder().setURL(url));
  }
  const container = new ContainerBuilder();
  if (options?.accentColor !== undefined) {
    container.setAccentColor(options.accentColor);
  }
  container.addMediaGalleryComponents(gallery);
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}
