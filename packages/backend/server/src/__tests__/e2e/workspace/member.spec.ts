import { randomUUID } from 'node:crypto';

import {
  acceptInviteByInviteIdMutation,
  addWorkspaceMembersMutation,
  approveWorkspaceTeamMemberMutation,
  createInviteLinkMutation,
  getInviteInfoQuery,
  grantWorkspaceTeamMemberMutation,
  inviteByEmailsMutation,
  leaveWorkspaceMutation,
  Permission,
  revokeMemberPermissionMutation,
  WorkspaceInviteLinkExpireTime,
  workspaceMemberCandidatesQuery,
  WorkspaceMemberStatus,
} from '@affine/graphql';
import { faker } from '@faker-js/faker';
import {
  WorkspaceMemberSource,
  WorkspaceMemberStatus as PrismaWorkspaceMemberStatus,
} from '@prisma/client';

import { EntitlementService } from '../../../core/entitlement';
import type { SendMailCommand } from '../../../core/mail/types';
import type { MailName } from '../../../mails';
import {
  type InvitationNotification,
  type InvitationReviewDeclinedNotification,
  Models,
  NotificationType,
  WorkspaceRole as ModelWorkspaceRole,
} from '../../../models';
import { SubscriptionPlan } from '../../../plugins/payment/types';
import { Mockers } from '../../mocks';
import { createRealtimeClient, realtimeRequest } from '../realtime';
import { app, e2e } from '../test';

async function createWorkspace() {
  const owner = await app.create(Mockers.User);
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
  });

  return {
    owner,
    workspace,
  };
}

async function grantTeamPlan(workspaceId: string, quantity: number) {
  await app.get(EntitlementService).upsertAdminGrant({
    targetType: 'workspace',
    targetId: workspaceId,
    plan: SubscriptionPlan.Team,
    quantity,
  });
}

async function revokeTeamPlan(workspaceId: string) {
  await app.get(EntitlementService).revokeAdminGrant('workspace', workspaceId);
}

async function waitForInvitationNotification(userId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [notification] = await app.models.notification.findManyByUserId(
      userId,
      {
        includeRead: true,
        first: 1,
        offset: 0,
      }
    );
    if (notification?.type === NotificationType.Invitation) {
      return notification as InvitationNotification;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Invitation notification was not created');
}

/**
 * The suite runs in cloud mode; direct membership is self-hosted only.
 */
async function asSelfhosted<T>(fn: () => Promise<T>) {
  const previous = globalThis.env.DEPLOYMENT_TYPE;
  // @ts-expect-error override
  globalThis.env.DEPLOYMENT_TYPE = 'selfhosted';
  try {
    return await fn();
  } finally {
    // @ts-expect-error override
    globalThis.env.DEPLOYMENT_TYPE = previous;
  }
}

async function waitForMailTo<Mail extends MailName>(name: Mail, to: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const call = app.mails.send
      .getCalls()
      .find(call => call.args[0].name === name && call.args[0].to === to);
    if (call) {
      return call.args[0] as SendMailCommand & { name: Mail };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Mail ${name} to ${to} was not sent`);
}

e2e('should invite a user', async t => {
  const { owner, workspace } = await createWorkspace();
  const u2 = await app.create(Mockers.User);

  await app.login(owner);
  const result = await app.gql({
    query: inviteByEmailsMutation,
    variables: {
      emails: [u2.email],
      workspaceId: workspace.id,
    },
  });

  t.truthy(result, 'failed to invite user');
  const invitation = await waitForInvitationNotification(u2.id);
  t.is(invitation.type, NotificationType.Invitation);
  t.is(invitation.body.createdByUserId, owner.id);
  t.is(invitation.body.inviteId, result.inviteMembers[0].inviteId!);

  await t.throwsAsync(
    app.gql({
      query: getInviteInfoQuery,
      variables: {
        inviteId: invitation.body.inviteId,
      },
    }),
    { message: 'This invitation belongs to another account.' }
  );
  await t.throwsAsync(
    app.gql({
      query: acceptInviteByInviteIdMutation,
      variables: {
        workspaceId: workspace.id,
        inviteId: invitation.body.inviteId,
      },
    }),
    { message: 'This invitation belongs to another account.' }
  );

  await app.logout();
  await t.throwsAsync(
    app.gql({
      query: getInviteInfoQuery,
      variables: {
        inviteId: invitation.body.inviteId,
      },
    }),
    { message: 'You must sign in first to access this resource.' }
  );
  await t.throwsAsync(
    app.gql({
      query: acceptInviteByInviteIdMutation,
      variables: {
        workspaceId: workspace.id,
        inviteId: invitation.body.inviteId,
      },
    }),
    { message: 'You must sign in first to access this resource.' }
  );

  await app.login(u2);
  // invitation status is pending
  const { getInviteInfo } = await app.gql({
    query: getInviteInfoQuery,
    variables: {
      inviteId: invitation.body.inviteId,
    },
  });
  t.is(getInviteInfo.status, WorkspaceMemberStatus.Pending);

  // u2 accept invite
  await app.gql({
    query: acceptInviteByInviteIdMutation,
    variables: {
      workspaceId: workspace.id,
      inviteId: invitation.body.inviteId,
    },
  });

  // invitation status is accepted
  const { getInviteInfo: getInviteInfo2 } = await app.gql({
    query: getInviteInfoQuery,
    variables: {
      inviteId: invitation.body.inviteId,
    },
  });
  t.is(getInviteInfo2.status, WorkspaceMemberStatus.Accepted);
});

e2e(
  'should remove charged invitations when the team entitlement is revoked',
  async t => {
    const { owner, workspace } = await createWorkspace();
    const member = await app.create(Mockers.User);
    await grantTeamPlan(workspace.id, 12);

    await Promise.all(
      Array.from({ length: 10 }).map(async () => {
        await app.create(Mockers.WorkspaceUser, {
          workspaceId: workspace.id,
          userId: (await app.create(Mockers.User)).id,
        });
      })
    );

    await app.login(owner);
    const invite = await app.gql({
      query: inviteByEmailsMutation,
      variables: {
        emails: [member.email],
        workspaceId: workspace.id,
      },
    });

    await revokeTeamPlan(workspace.id);

    await app.login(member);
    await t.throwsAsync(
      app.gql({
        query: acceptInviteByInviteIdMutation,
        variables: {
          workspaceId: workspace.id,
          inviteId: invite.inviteMembers[0].inviteId!,
        },
      })
    );

    await t.throwsAsync(
      app.gql({
        query: getInviteInfoQuery,
        variables: {
          inviteId: invite.inviteMembers[0].inviteId!,
        },
      }),
      { message: 'Invitation not found' }
    );
  }
);

e2e('should leave a workspace', async t => {
  const { owner, workspace } = await createWorkspace();
  const u2 = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: u2.id,
  });

  await app.login(u2);
  const { leaveWorkspace } = await app.gql({
    query: leaveWorkspaceMutation,
    variables: {
      workspaceId: workspace.id,
    },
  });

  t.true(leaveWorkspace, 'failed to leave workspace');

  const leaveMail = await app.mails.waitFor('MemberLeave');

  t.is(leaveMail.to, owner.email);
  t.is(leaveMail.props.user.$$userId, u2.id);
});

e2e('should revoke a user', async t => {
  const u2 = await app.signup();
  const owner = await app.signup();

  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
  });
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: u2.id,
  });

  const { revokeMember } = await app.gql({
    query: revokeMemberPermissionMutation,
    variables: {
      workspaceId: workspace.id,
      userId: u2.id,
    },
  });
  t.true(revokeMember, 'failed to revoke user');
});

e2e('should map every workspace role transition without fallback', async t => {
  const roles = [
    {
      graphql: Permission.Owner,
      model: ModelWorkspaceRole.Owner,
    },
    {
      graphql: Permission.Admin,
      model: ModelWorkspaceRole.Admin,
    },
    {
      graphql: Permission.Collaborator,
      model: ModelWorkspaceRole.Collaborator,
    },
    {
      graphql: Permission.External,
      model: ModelWorkspaceRole.External,
    },
  ];

  for (const current of roles) {
    for (const next of roles) {
      const actor = await app.create(Mockers.User);
      const target =
        current.model === ModelWorkspaceRole.Owner
          ? actor
          : await app.create(Mockers.User);
      const workspace = await app.create(Mockers.Workspace, {
        owner: { id: actor.id },
      });
      await grantTeamPlan(workspace.id, 2);
      if (
        current.model !== ModelWorkspaceRole.External &&
        current.model !== ModelWorkspaceRole.Owner
      ) {
        await app.create(Mockers.WorkspaceUser, {
          workspaceId: workspace.id,
          userId: target.id,
          type: current.model,
        });
      }
      await app.login(actor);

      const mutation = app.gql({
        query: grantWorkspaceTeamMemberMutation,
        variables: {
          workspaceId: workspace.id,
          userId: target.id,
          permission: next.graphql,
        },
      });
      const allowed =
        current.model === ModelWorkspaceRole.Admin ||
        current.model === ModelWorkspaceRole.Collaborator ||
        (current.model === ModelWorkspaceRole.Owner &&
          next.model === ModelWorkspaceRole.Owner);

      if (!allowed) {
        await t.throwsAsync(mutation);
        continue;
      }

      const { grantMember } = await mutation;
      t.true(grantMember);
      const member = await app
        .get(Models)
        .workspaceUser.get(workspace.id, target.id);
      if (next.model === ModelWorkspaceRole.External) {
        t.falsy(member);
      } else {
        t.is(member?.type, next.model);
      }
    }
  }
});

e2e('should send role changed mails when a member role changes', async t => {
  const { owner, workspace } = await createWorkspace();
  const member = await app.create(Mockers.User);
  await grantTeamPlan(workspace.id, 3);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
  });

  await app.login(owner);
  await app.gql({
    query: grantWorkspaceTeamMemberMutation,
    variables: {
      workspaceId: workspace.id,
      userId: member.id,
      permission: Permission.Admin,
    },
  });
  const promoted = await waitForMailTo('TeamBecomeAdmin', member.email);
  t.is(promoted.props.workspace.$$workspaceId, workspace.id);

  await app.gql({
    query: grantWorkspaceTeamMemberMutation,
    variables: {
      workspaceId: workspace.id,
      userId: member.id,
      permission: Permission.Collaborator,
    },
  });
  const demoted = await waitForMailTo('TeamBecomeCollaborator', member.email);
  t.is(demoted.props.workspace.$$workspaceId, workspace.id);
});

e2e('should send ownership mails when ownership is transferred', async t => {
  const { owner, workspace } = await createWorkspace();
  const member = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
  });

  await app.login(owner);
  const { grantMember } = await app.gql({
    query: grantWorkspaceTeamMemberMutation,
    variables: {
      workspaceId: workspace.id,
      userId: member.id,
      permission: Permission.Owner,
    },
  });
  t.true(grantMember);

  const transferred = await waitForMailTo('OwnershipTransferred', owner.email);
  t.is(transferred.props.workspace.$$workspaceId, workspace.id);
  const received = await waitForMailTo('OwnershipReceived', member.email);
  t.is(received.props.workspace.$$workspaceId, workspace.id);
});

e2e('should explain that admin roles need a team workspace', async t => {
  const { owner, workspace } = await createWorkspace();
  const member = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
  });

  await app.login(owner);
  await t.throwsAsync(
    app.gql({
      query: grantWorkspaceTeamMemberMutation,
      variables: {
        workspaceId: workspace.id,
        userId: member.id,
        permission: Permission.Admin,
      },
    }),
    { message: 'A Team workspace is required to perform this action.' }
  );
});

e2e(
  'should report already joined when an accepted invitation is reused',
  async t => {
    const { owner, workspace } = await createWorkspace();
    const member = await app.create(Mockers.User);

    await app.login(owner);
    const { inviteMembers } = await app.gql({
      query: inviteByEmailsMutation,
      variables: {
        emails: [member.email],
        workspaceId: workspace.id,
      },
    });
    const inviteId = inviteMembers[0].inviteId!;

    await app.login(member);
    await app.gql({
      query: acceptInviteByInviteIdMutation,
      variables: { workspaceId: workspace.id, inviteId },
    });

    await t.throwsAsync(
      app.gql({
        query: acceptInviteByInviteIdMutation,
        variables: { workspaceId: workspace.id, inviteId },
      }),
      { message: `You have already joined in Space ${workspace.id}.` }
    );
  }
);

e2e('should add registered accounts to a workspace directly', async t => {
  const { owner, workspace } = await createWorkspace();
  const alice = await app.create(Mockers.User, { name: 'Alice Direct' });
  const bob = await app.create(Mockers.User, { name: 'Bob Direct' });

  await app.login(owner);
  await asSelfhosted(async () => {
    const { workspaceMemberCandidates } = await app.gql({
      query: workspaceMemberCandidatesQuery,
      variables: { workspaceId: workspace.id, query: 'Direct' },
    });
    t.deepEqual(
      workspaceMemberCandidates.map(c => [c.id, c.status]).sort(),
      [
        [alice.id, null],
        [bob.id, null],
      ].sort()
    );

    const { addWorkspaceMembers } = await app.gql({
      query: addWorkspaceMembersMutation,
      variables: { workspaceId: workspace.id, userIds: [alice.id, bob.id] },
    });
    t.deepEqual(
      addWorkspaceMembers.map(r => [r.userId, r.error ?? null]),
      [
        [alice.id, null],
        [bob.id, null],
      ]
    );

    for (const user of [alice, bob]) {
      const member = await app
        .get(Models)
        .workspaceUser.get(workspace.id, user.id);
      t.is(member?.status, WorkspaceMemberStatus.Accepted);
      t.is(member?.type, ModelWorkspaceRole.Collaborator);
    }

    // adding again reports the conflict per user instead of failing
    const { addWorkspaceMembers: again } = await app.gql({
      query: addWorkspaceMembersMutation,
      variables: { workspaceId: workspace.id, userIds: [alice.id] },
    });
    t.is(again[0].error?.name, 'ALREADY_IN_SPACE');

    const { workspaceMemberCandidates: after } = await app.gql({
      query: workspaceMemberCandidatesQuery,
      variables: { workspaceId: workspace.id, query: 'Alice Direct' },
    });
    t.is(after[0]?.status, WorkspaceMemberStatus.Accepted);
  });
});

e2e('should activate a pending link request when added directly', async t => {
  const { owner, workspace } = await createWorkspace();
  const user = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: user.id,
    status: WorkspaceMemberStatus.UnderReview,
    kind: 'link',
  });

  await app.login(owner);
  await asSelfhosted(async () => {
    const { addWorkspaceMembers } = await app.gql({
      query: addWorkspaceMembersMutation,
      variables: { workspaceId: workspace.id, userIds: [user.id] },
    });
    t.falsy(addWorkspaceMembers[0].error);
  });
  t.is(
    (await app.get(Models).workspaceUser.get(workspace.id, user.id))?.status,
    WorkspaceMemberStatus.Accepted
  );
});

e2e('should refuse direct membership outside self-hosted', async t => {
  const { owner, workspace } = await createWorkspace();
  const user = await app.create(Mockers.User);

  await app.login(owner);
  await t.throwsAsync(
    app.gql({
      query: addWorkspaceMembersMutation,
      variables: { workspaceId: workspace.id, userIds: [user.id] },
    }),
    { message: /only available on self-hosted/ }
  );
  await t.throwsAsync(
    app.gql({
      query: workspaceMemberCandidatesQuery,
      variables: { workspaceId: workspace.id },
    }),
    { message: /only available on self-hosted/ }
  );
});

e2e('should require manage permission to add members directly', async t => {
  const { workspace } = await createWorkspace();
  const member = await app.create(Mockers.User);
  const outsider = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
  });

  await app.login(member);
  await asSelfhosted(async () => {
    await t.throwsAsync(
      app.gql({
        query: addWorkspaceMembersMutation,
        variables: { workspaceId: workspace.id, userIds: [outsider.id] },
      })
    );
  });
  t.falsy(await app.get(Models).workspaceUser.get(workspace.id, outsider.id));
});

e2e('should approve a user on under review', async t => {
  const { owner, workspace } = await createWorkspace();
  const user = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: user.id,
    status: WorkspaceMemberStatus.UnderReview,
    kind: 'link',
  });

  await app.login(owner);
  const { approveMember } = await app.gql({
    query: approveWorkspaceTeamMemberMutation,
    variables: {
      workspaceId: workspace.id,
      userId: user.id,
    },
  });

  t.true(approveMember, 'failed to approve member');

  t.is(
    (await app.get(Models).workspaceUser.get(workspace.id, user.id))?.status,
    WorkspaceMemberStatus.Accepted
  );
});

e2e('should revoke a user on under review', async t => {
  const { owner, workspace } = await createWorkspace();
  const user = await app.create(Mockers.User);
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: user.id,
    status: WorkspaceMemberStatus.UnderReview,
  });

  await app.login(owner);
  const { revokeMember } = await app.gql({
    query: revokeMemberPermissionMutation,
    variables: {
      workspaceId: workspace.id,
      userId: user.id,
    },
  });
  t.true(revokeMember, 'failed to revoke user');
  const [requestDeclinedNotification] =
    await app.models.notification.findManyByUserId(user.id, {
      includeRead: true,
      first: 1,
      offset: 0,
    });
  const declined =
    requestDeclinedNotification as InvitationReviewDeclinedNotification;
  t.is(declined.type, NotificationType.InvitationReviewDeclined);
  t.is(declined.userId, user.id);
  t.is(declined.body.workspaceId, workspace.id);
  t.is(declined.body.createdByUserId, owner.id);
});

e2e('should create user if not exist', async t => {
  const { owner, workspace } = await createWorkspace();

  const email = faker.internet.email();
  await app.login(owner);
  await app.gql({
    query: inviteByEmailsMutation,
    variables: {
      emails: [email],
      workspaceId: workspace.id,
    },
  });

  const u2 = await app.get(Models).user.getUserByEmail(email);
  t.truthy(u2, 'failed to create user');
});

e2e('should support pagination for member', async t => {
  const { owner, workspace } = await createWorkspace();
  const u1 = await app.create(Mockers.User);
  const u2 = await app.create(Mockers.User);

  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: u1.id,
  });
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: u2.id,
  });

  const socket = await createRealtimeClient(app, owner);
  t.teardown(() => socket.disconnect());
  let result = await realtimeRequest(socket, 'workspace.members.get', {
    workspaceId: workspace.id,
    skip: 0,
    take: 2,
  });
  t.is(result.memberCount, 3);
  t.is(result.members.length, 2);

  result = await realtimeRequest(socket, 'workspace.members.get', {
    workspaceId: workspace.id,
    skip: 2,
    take: 2,
  });
  t.is(result.memberCount, 3);
  t.is(result.members.length, 1);

  result = await realtimeRequest(socket, 'workspace.members.get', {
    workspaceId: workspace.id,
    skip: 3,
    take: 2,
  });
  t.is(result.memberCount, 3);
  t.is(result.members.length, 0);
});

e2e('should limit member count correctly', async t => {
  const { owner, workspace } = await createWorkspace();

  await Promise.all(
    Array.from({ length: 10 }).map(async () => {
      const user = await app.create(Mockers.User);
      await app.create(Mockers.WorkspaceUser, {
        workspaceId: workspace.id,
        userId: user.id,
      });
    })
  );

  const socket = await createRealtimeClient(app, owner);
  t.teardown(() => socket.disconnect());
  const result = await realtimeRequest(socket, 'workspace.members.get', {
    workspaceId: workspace.id,
    skip: 0,
    take: 10,
  });
  t.is(result.memberCount, 11);
  t.is(result.members.length, 10);
});

e2e('should get invite link info with status', async t => {
  const { owner, workspace } = await createWorkspace();

  await app.login(owner);
  const { createInviteLink } = await app.gql({
    query: createInviteLinkMutation,
    variables: {
      workspaceId: workspace.id,
      expireTime: WorkspaceInviteLinkExpireTime.OneDay,
    },
  });
  t.truthy(createInviteLink, 'failed to create invite link');
  const link = createInviteLink.link;
  const inviteId = link.split('/').pop()!;

  // owner/member see accept status
  const { getInviteInfo } = await app.gql({
    query: getInviteInfoQuery,
    variables: {
      inviteId,
    },
  });
  t.truthy(getInviteInfo, 'failed to get invite info');
  t.is(getInviteInfo.status, WorkspaceMemberStatus.Accepted);

  // non-member see null status
  await app.signup();
  const { getInviteInfo: getInviteInfo2 } = await app.gql({
    query: getInviteInfoQuery,
    variables: {
      inviteId,
    },
  });
  t.truthy(getInviteInfo2, 'failed to get invite info');
  t.is(getInviteInfo2.status, null);

  // pending-member see under review status
  await app.signup();
  await app.gql({
    query: acceptInviteByInviteIdMutation,
    variables: {
      workspaceId: workspace.id,
      inviteId,
    },
  });
  const { getInviteInfo: getInviteInfo3 } = await app.gql({
    query: getInviteInfoQuery,
    variables: {
      inviteId,
    },
  });
  t.truthy(getInviteInfo3, 'failed to get invite info');
  t.is(getInviteInfo3.status, WorkspaceMemberStatus.UnderReview);
});

e2e(
  'should accept invitation by link directly if status is pending',
  async t => {
    const { owner, workspace } = await createWorkspace();
    const member = await app.create(Mockers.User);

    await app.login(owner);
    // create a pending invitation
    const invite = await app.gql({
      query: inviteByEmailsMutation,
      variables: {
        emails: [member.email],
        workspaceId: workspace.id,
      },
    });
    t.truthy(invite, 'failed to create invitation');

    const { createInviteLink } = await app.gql({
      query: createInviteLinkMutation,
      variables: {
        workspaceId: workspace.id,
        expireTime: WorkspaceInviteLinkExpireTime.OneDay,
      },
    });
    t.truthy(createInviteLink, 'failed to create invite link');
    const link = createInviteLink.link;
    const inviteLinkId = link.split('/').pop()!;

    // member accept invitation by link
    await app.login(member);
    await app.gql({
      query: acceptInviteByInviteIdMutation,
      variables: {
        inviteId: inviteLinkId,
        workspaceId: workspace.id,
      },
    });

    const { getInviteInfo } = await app.gql({
      query: getInviteInfoQuery,
      variables: {
        inviteId: invite.inviteMembers[0].inviteId!,
      },
    });
    t.is(getInviteInfo.status, WorkspaceMemberStatus.Accepted);
  }
);

e2e(
  'should invite by link and send review request notification below quota limit',
  async t => {
    const { owner, workspace } = await createWorkspace();

    await app.login(owner);
    const { createInviteLink } = await app.gql({
      query: createInviteLinkMutation,
      variables: {
        workspaceId: workspace.id,
        expireTime: WorkspaceInviteLinkExpireTime.OneDay,
      },
    });
    t.truthy(createInviteLink, 'failed to create invite link');
    const link = createInviteLink.link;
    const inviteId = link.split('/').pop()!;

    // accept invite by link
    await app.signup();
    const result = await app.gql({
      query: acceptInviteByInviteIdMutation,
      variables: {
        workspaceId: workspace.id,
        inviteId,
      },
    });
    t.truthy(result, 'failed to accept invite');
    const [notification] = await app.models.notification.findManyByUserId(
      owner.id,
      { includeRead: true, first: 1, offset: 0 }
    );
    const review = notification as InvitationNotification;
    t.is(review.type, NotificationType.InvitationReviewRequest);
    t.is(review.userId, owner.id);
    t.truthy(review.body.inviteId);
  }
);

e2e(
  'should invite by link and send review request notification over quota limit',
  async t => {
    const { owner, workspace } = await createWorkspace();
    await grantTeamPlan(workspace.id, 3);

    await app.login(owner);
    const { createInviteLink } = await app.gql({
      query: createInviteLinkMutation,
      variables: {
        workspaceId: workspace.id,
        expireTime: WorkspaceInviteLinkExpireTime.OneDay,
      },
    });
    t.truthy(createInviteLink, 'failed to create invite link');
    const link = createInviteLink.link;
    const inviteId = link.split('/').pop()!;

    // accept invite by link
    await app.signup();
    const result = await app.gql({
      query: acceptInviteByInviteIdMutation,
      variables: {
        workspaceId: workspace.id,
        inviteId,
      },
    });
    t.truthy(result, 'failed to accept invite');
    const [notification] = await app.models.notification.findManyByUserId(
      owner.id,
      { includeRead: true, first: 1, offset: 0 }
    );
    const review = notification as InvitationNotification;
    t.is(review.type, NotificationType.InvitationReviewRequest);
    t.is(review.userId, owner.id);
    t.truthy(review.body.inviteId);
  }
);

e2e(
  'should search members by name and email support case insensitive',
  async t => {
    const { owner, workspace } = await createWorkspace();
    const user1 = await app.create(Mockers.User, {
      name: faker.internet.displayName({ firstName: 'Lucy' }),
    });
    const user2 = await app.create(Mockers.User, {
      email: `jeanne_doe.${randomUUID()}@affine.pro`,
    });
    await app.create(Mockers.WorkspaceUser, {
      workspaceId: workspace.id,
      userId: user1.id,
    });
    await app.create(Mockers.WorkspaceUser, {
      workspaceId: workspace.id,
      userId: user2.id,
    });

    const socket = await createRealtimeClient(app, owner);
    t.teardown(() => socket.disconnect());
    let result = await realtimeRequest(socket, 'workspace.members.get', {
      workspaceId: workspace.id,
      query: 'lucy',
    });
    t.is(result.memberCount, 3);
    t.is(result.members.length, 1);
    t.is(result.members[0].name, user1.name);

    result = await realtimeRequest(socket, 'workspace.members.get', {
      workspaceId: workspace.id,
      query: 'LUCY',
    });
    t.is(result.memberCount, 3);
    t.is(result.members.length, 1);
    t.is(result.members[0].name, user1.name);

    result = await realtimeRequest(socket, 'workspace.members.get', {
      workspaceId: workspace.id,
      query: 'jeanne_doe',
    });
    t.is(result.memberCount, 3);
    t.is(result.members.length, 1);
    t.is(result.members[0].email, user2.email);

    const pendingEmail = `pending_search.${randomUUID()}@affine.pro`;
    const pendingUser = await app.create(Mockers.User, {
      email: pendingEmail,
    });
    await app
      .get(Models)
      .workspaceUser.set(
        workspace.id,
        pendingUser.id,
        ModelWorkspaceRole.Collaborator,
        {
          status: PrismaWorkspaceMemberStatus.Pending,
          source: WorkspaceMemberSource.Email,
        }
      );
    result = await realtimeRequest(socket, 'workspace.members.get', {
      workspaceId: workspace.id,
      query: 'pending_search',
    });
    t.is(result.memberCount, 4);
    t.is(result.members.length, 1);
    t.is(result.members[0].email, pendingEmail);
    t.is(result.members[0].status, WorkspaceMemberStatus.Pending);
  }
);
