// @ts-nocheck — fixture
export const inviteRunner = {
  id: "invite-flow",
  event: "averri/MemberInvited",
  async run({ event, step }) {
    await step.run("load", async () => event.data);
    await step.run("email", async () => event.data.email);
  },
};
