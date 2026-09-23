export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Mindful Expense Planner")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

export function include(filename: string): string {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

Object.assign(globalThis, { doGet, include });
