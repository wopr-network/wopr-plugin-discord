import { describe, expect, it } from "vitest";
import {
  type AuditFinding,
  type AuditSeverity,
  eventNameChanges,
  fileAuditSummary,
  generateAuditReport,
  getFindingsBySeverity,
  getFindingsForFile,
  typeRenames,
  v15AuditFindings,
} from "../../src/compat/v15-audit.js";

describe("v15-audit", () => {
  describe("v15AuditFindings", () => {
    it("should contain findings", () => {
      expect(v15AuditFindings.length).toBeGreaterThan(0);
    });

    it("each finding should have required fields", () => {
      for (const finding of v15AuditFindings) {
        expect(finding.id).toBeTruthy();
        expect(finding.file).toBeTruthy();
        expect(finding.line).toBeGreaterThan(0);
        expect(["breaking", "deprecation", "style"]).toContain(finding.severity);
        expect(finding.category).toBeTruthy();
        expect(finding.description).toBeTruthy();
        expect(finding.currentPattern).toBeTruthy();
        expect(finding.v15Replacement).toBeTruthy();
        expect(["trivial", "low", "medium", "high"]).toContain(finding.effort);
      }
    });

    it("each finding should have a unique id", () => {
      const ids = v15AuditFindings.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("should include the Message#interaction breaking change", () => {
      const finding = v15AuditFindings.find((f) => f.id === "V15-001");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("breaking");
      expect(finding!.file).toBe("src/event-handlers.ts");
      expect(finding!.category).toContain("interaction");
    });

    it("should include the ephemeral option removal", () => {
      const finding = v15AuditFindings.find((f) => f.id === "V15-005");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("breaking");
      expect(finding!.file).toBe("src/slash-commands.ts");
    });

    it("should include getFocused() parameter removal", () => {
      const finding = v15AuditFindings.find((f) => f.id === "V15-003");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("breaking");
    });
  });

  describe("getFindingsForFile", () => {
    it("should return findings for event-handlers.ts", () => {
      const findings = getFindingsForFile("src/event-handlers.ts");
      expect(findings.length).toBe(2);
    });

    it("should return findings for slash-commands.ts", () => {
      const findings = getFindingsForFile("src/slash-commands.ts");
      expect(findings.length).toBe(3);
    });

    it("should return empty array for clean files", () => {
      const findings = getFindingsForFile("src/index.ts");
      expect(findings.length).toBe(0);
    });

    it("should return empty array for unknown files", () => {
      const findings = getFindingsForFile("src/nonexistent.ts");
      expect(findings.length).toBe(0);
    });
  });

  describe("getFindingsBySeverity", () => {
    it("should return breaking findings", () => {
      const findings = getFindingsBySeverity("breaking");
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.severity).toBe("breaking");
      }
    });

    it("should return style findings", () => {
      const findings = getFindingsBySeverity("style");
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.severity).toBe("style");
      }
    });
  });

  describe("eventNameChanges", () => {
    it("should include clientReady rename", () => {
      expect(eventNameChanges.clientReady).toEqual({
        v14: "ready",
        v15: "clientReady",
        status: "renamed",
      });
    });

    it("should include webhooksUpdate rename", () => {
      expect(eventNameChanges.webhooksUpdate).toEqual({
        v14: "webhookUpdate",
        v15: "webhooksUpdate",
        status: "renamed",
      });
    });

    it("should mark shard events as removed", () => {
      expect(eventNameChanges.shardDisconnect.status).toBe("removed");
      expect(eventNameChanges.shardError.status).toBe("removed");
      expect(eventNameChanges.shardReady.status).toBe("removed");
      expect(eventNameChanges.shardReconnecting.status).toBe("removed");
      expect(eventNameChanges.shardResume.status).toBe("removed");
    });
  });

  describe("typeRenames", () => {
    it("should map NewsChannel to AnnouncementChannel", () => {
      expect(typeRenames.NewsChannel).toBe("AnnouncementChannel");
    });

    it("should map ClientEvents to ClientEventTypes", () => {
      expect(typeRenames.ClientEvents).toBe("ClientEventTypes");
    });

    it("should map SelectMenuBuilder to StringSelectMenuBuilder", () => {
      expect(typeRenames.SelectMenuBuilder).toBe("StringSelectMenuBuilder");
    });
  });

  describe("fileAuditSummary", () => {
    it("should cover all source files", () => {
      const files = Object.keys(fileAuditSummary);
      expect(files.length).toBeGreaterThanOrEqual(13);
    });

    it("should mark event-handlers.ts as needs-update", () => {
      expect(fileAuditSummary["src/event-handlers.ts"].status).toBe("needs-update");
    });

    it("should mark slash-commands.ts as needs-update", () => {
      expect(fileAuditSummary["src/slash-commands.ts"].status).toBe("needs-update");
    });

    it("should mark index.ts as clean", () => {
      expect(fileAuditSummary["src/index.ts"].status).toBe("clean");
    });

    it("finding counts should match actual findings", () => {
      for (const [file, info] of Object.entries(fileAuditSummary)) {
        const actual = getFindingsForFile(file).length;
        expect(info.findings).toBe(actual);
      }
    });
  });

  describe("generateAuditReport", () => {
    it("should produce a non-empty report", () => {
      const report = generateAuditReport();
      expect(report.length).toBeGreaterThan(0);
    });

    it("should include all finding IDs", () => {
      const report = generateAuditReport();
      for (const finding of v15AuditFindings) {
        expect(report).toContain(finding.id);
      }
    });

    it("should include affected file paths", () => {
      const report = generateAuditReport();
      expect(report).toContain("src/event-handlers.ts");
      expect(report).toContain("src/slash-commands.ts");
    });

    it("should include the version info", () => {
      const report = generateAuditReport();
      expect(report).toContain("^14.14.1");
      expect(report).toContain("15.x");
    });
  });
});
