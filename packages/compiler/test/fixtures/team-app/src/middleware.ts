// @ts-nocheck — fixture
export const auth = async (c, next) => {
  c.set("actor", { id: c.req.header("authorization") ?? "anon" });
  await next();
};
