export default {
  sourceRoots: ["src"],
  prismaSchema: "prisma/schema.prisma",
  entryPoints: ["src/app.ts"],
  authMiddleware: ["auth", "requireUser"],
  publicMarker: "publicRoute",
  actors: { anonymous: { actor: null } },
};
