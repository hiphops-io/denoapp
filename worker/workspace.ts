export const workspace = () => {
  // TODO: WORKSPACE_DIR shouldn't be a global var given we're doing JIT creation
  try {
    Deno.mkdirSync(WORKSPACE_DIR, {});
  } catch (err) {
    if (err! instanceof Deno.errors.AlreadyExists) {
      throw err;
    }
  }

  return WORKSPACE_DIR;
};