import { createApi } from "./api";
import type { ApiError } from "./api";
import { createStore } from "./state";
import { mountShell } from "./render";

function normalizeError(error: unknown): ApiError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return error as ApiError;
  }
  return { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." };
}

const app = document.querySelector<HTMLElement>("#app");

if (app) {
  const store = createStore();
  mountShell(app, store);

  const api = createApi();
  api
    .getBootstrap()
    .then(bootstrap => store.setState({ status: "ready", bootstrap, error: null }))
    .catch((error: unknown) => store.setState({ status: "error", error: normalizeError(error) }));
}
