// Offline stub — auth handled by local cookie routes; nothing cloud here.
export const auth = {
  getSession: async () => null,
  api: { getSession: async () => null },
}
