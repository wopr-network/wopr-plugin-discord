import { describe, it, expect } from "vitest";
import {
  textToComponentsV2,
  textToComponentsV2Edit,
  mediaGalleryToComponentsV2,
} from "../src/components-v2.js";
import { MessageFlags } from "discord.js";

describe("components-v2", () => {
  describe("textToComponentsV2", () => {
    it("should wrap text in a Container with TextDisplay", () => {
      const result = textToComponentsV2("Hello world");
      expect(result.flags).toBe(MessageFlags.IsComponentsV2);
      expect(result.components).toBeDefined();
      expect(result.components!.length).toBe(1); // one Container
      const container = result.components![0];
      const json = container.toJSON();
      // ComponentType.Container = 17
      expect(json.type).toBe(17);
      // Should contain a TextDisplay (type 10)
      const textDisplay = json.components.find((c: any) => c.type === 10);
      expect(textDisplay).toBeDefined();
      expect(textDisplay!.content).toBe("Hello world");
    });

    it("should apply accent color when provided", () => {
      const result = textToComponentsV2("Styled", { accentColor: 0x5865f2 });
      const json = result.components![0].toJSON();
      expect(json.accent_color).toBe(0x5865f2);
    });

    it("should set no content field (v2 messages use components only)", () => {
      const result = textToComponentsV2("Test");
      expect(result.content).toBeUndefined();
    });
  });

  describe("textToComponentsV2Edit", () => {
    it("should return components without flags (flags persist on edit)", () => {
      const result = textToComponentsV2Edit("Edited text");
      expect(result.flags).toBeUndefined();
      expect(result.components).toBeDefined();
      const json = result.components![0].toJSON();
      expect(json.type).toBe(17);
      const textDisplay = json.components.find((c: any) => c.type === 10);
      expect(textDisplay!.content).toBe("Edited text");
    });
  });

  describe("mediaGalleryToComponentsV2", () => {
    it("should create a container with a MediaGallery", () => {
      const urls = ["https://example.com/a.png", "https://example.com/b.png"];
      const result = mediaGalleryToComponentsV2(urls);
      expect(result.flags).toBe(MessageFlags.IsComponentsV2);
      const json = result.components![0].toJSON();
      expect(json.type).toBe(17); // Container
      // ComponentType.MediaGallery = 12
      const gallery = json.components.find((c: any) => c.type === 12);
      expect(gallery).toBeDefined();
      expect(gallery!.items.length).toBe(2);
      expect(gallery!.items[0].media.url).toBe("https://example.com/a.png");
    });

    it("should handle empty urls gracefully by omitting the gallery", () => {
      const result = mediaGalleryToComponentsV2([]);
      // No components when no URLs — avoids discord.js validation error on empty MediaGallery
      expect(result.components).toHaveLength(0);
    });
  });
});
