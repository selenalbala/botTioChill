const { DELETE_REVIEW_ROLE_ID } = require("../config");
const db = require("../db");
const { logAction } = require("./actionLogService");
const {
  getMemberRoleIds,
  memberHasAllowedRole,
  memberHasDeleteReviewRole
} = require("./complianceService");
const { refreshMetaPanel } = require("./panelService");

async function handleGuildMemberUpdate(client, oldMember, newMember) {
  const hadAllowedRole = memberHasAllowedRole(oldMember);
  const hasAllowedRoleNow = memberHasAllowedRole(newMember);
  const hasDeleteReviewRole = memberHasDeleteReviewRole(newMember);

  if (!hadAllowedRole || hasAllowedRoleNow || !hasDeleteReviewRole) {
    return null;
  }

  const review = db.createRoleDeleteReview({
    created_at_utc: new Date().toISOString(),
    guild_id: newMember.guild.id,
    user_id: newMember.user.id,
    username: newMember.user.username,
    display_name: newMember.displayName,
    old_roles: JSON.stringify(getMemberRoleIds(oldMember)),
    new_roles: JSON.stringify(getMemberRoleIds(newMember)),
    reason: `Ha pasado de un rol autorizado al rol ${DELETE_REVIEW_ROLE_ID}`
  });

  await logAction(client, {
    guild_id: newMember.guild.id,
    user_id: newMember.user.id,
    username: newMember.user.username,
    display_name: newMember.displayName,
    action_type: "role_changed_to_delete_review",
    status: "pending",
    details: "Pendiente de aceptar o denegar desde la web."
  });

  return review;
}

async function acceptReviewFromWeb(client, reviewId, actor) {
  const review = db.getRoleDeleteReviewById(reviewId);

  if (!review) {
    throw new Error("No se encontró la revisión.");
  }

  if (review.status !== "pending") {
    throw new Error("Esta revisión ya está resuelta.");
  }

  const deleteResult = db.deleteTiradasByUser(review.user_id);

  db.resolveRoleDeleteReview({
    id: reviewId,
    status: "accepted",
    resolvedByUserId: actor.userId,
    resolvedByUsername: actor.username
  });

  await logAction(client, {
    guild_id: review.guild_id,
    user_id: review.user_id,
    username: review.username,
    display_name: review.display_name,
    action_type: "role_review_accepted_delete_user",
    status: "success",
    details: `Se han eliminado ${deleteResult.changes} registros de la BBDD. Aceptado por ${actor.username}.`
  });

  await refreshMetaPanel(client);

  return {
    review,
    deletedRows: deleteResult.changes
  };
}

async function denyReviewFromWeb(client, reviewId, actor) {
  const review = db.getRoleDeleteReviewById(reviewId);

  if (!review) {
    throw new Error("No se encontró la revisión.");
  }

  if (review.status !== "pending") {
    throw new Error("Esta revisión ya está resuelta.");
  }

  db.resolveRoleDeleteReview({
    id: reviewId,
    status: "denied",
    resolvedByUserId: actor.userId,
    resolvedByUsername: actor.username
  });

  await logAction(client, {
    guild_id: review.guild_id,
    user_id: review.user_id,
    username: review.username,
    display_name: review.display_name,
    action_type: "role_review_denied",
    status: "success",
    details: `No se ha borrado la BBDD. Denegado por ${actor.username}.`
  });

  return {
    review
  };
}

module.exports = {
  handleGuildMemberUpdate,
  acceptReviewFromWeb,
  denyReviewFromWeb
};
