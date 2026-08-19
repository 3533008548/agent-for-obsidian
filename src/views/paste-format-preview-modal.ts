import { App, Editor, Modal } from "obsidian";
import type { PasteFormatResult, PasteOutputKind, PasteQualityReport } from "../paste/paste-formatter";

export class PasteFormatPreviewModal extends Modal {
  private selectedOutput: PasteOutputKind;

  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly result: PasteFormatResult,
    private readonly title: string
  ) {
    super(app);
    this.selectedOutput = result.recommendedOutput;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    this.renderReport(this.result.report);

    const choice = this.contentEl.createDiv({ cls: "knowledge-loop-agent-paste-choice" });
    this.addChoice(choice, "markdown", "规范 Markdown 表格", this.result.markdown);
    if (this.result.preservedHtml) {
      this.addChoice(choice, "preserved-html", "保真 HTML 表格", this.result.preservedHtml);
    }

    const preview = this.contentEl.createEl("pre", { cls: "knowledge-loop-agent-paste-preview" });
    const refreshPreview = (): void => {
      preview.setText(this.getSelectedContent());
    };
    refreshPreview();
    choice.addEventListener("change", refreshPreview);

    const actions = this.contentEl.createDiv({ cls: "knowledge-loop-agent-suggestions" });
    const applyButton = actions.createEl("button", { text: "确认替换/插入", cls: "mod-cta" });
    applyButton.addEventListener("click", () => {
      this.editor.replaceSelection(this.getSelectedContent());
      this.close();
    });
    const closeButton = actions.createEl("button", { text: "取消" });
    closeButton.addEventListener("click", () => this.close());
  }

  private addChoice(parent: HTMLElement, value: PasteOutputKind, label: string, content: string): void {
    const wrapper = parent.createEl("label");
    const input = wrapper.createEl("input") as HTMLInputElement;
    input.type = "radio";
    input.name = "knowledge-loop-paste-output";
    input.value = value;
    input.checked = this.selectedOutput === value;
    input.addEventListener("change", () => {
      this.selectedOutput = value;
    });
    wrapper.appendText(` ${label}（${content.length} 字符）`);
  }

  private renderReport(report: PasteQualityReport): void {
    const details: string[] = [`类型：${describeKind(report.kind)}`];
    if (report.rowCount && report.columnCount) {
      details.push(`表格：${report.columnCount} 列 × ${report.rowCount} 行`);
    }
    if (report.repairedCellCount) {
      details.push(`本地补齐：${report.repairedCellCount} 个缺失单元格`);
    }
    this.contentEl.createEl("p", { text: details.join(" · ") });
    if (report.warnings.length) {
      const list = this.contentEl.createEl("ul");
      for (const warning of report.warnings) {
        list.createEl("li", { text: warning });
      }
    }
  }

  private getSelectedContent(): string {
    return this.selectedOutput === "preserved-html" && this.result.preservedHtml
      ? this.result.preservedHtml
      : this.result.markdown;
  }
}

function describeKind(kind: PasteQualityReport["kind"]): string {
  switch (kind) {
    case "html-table": return "HTML 表格";
    case "tsv-table": return "TSV / Excel 表格";
    case "markdown-table": return "Markdown 表格";
    case "rich-text": return "富文本";
    case "plain-text": return "纯文本";
  }
}
