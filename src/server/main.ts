export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Mindful Expense Planner")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

Object.assign(globalThis, { doGet });
