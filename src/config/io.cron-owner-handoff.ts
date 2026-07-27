import { beginLegacyDefaultOwnerHandoff } from "../cron/live-service-registry.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type CronOwnerHandoffTarget = {
  config: OpenClawConfig;
  storePath: string;
};

/** Seals and migrates every cron store until the config write commits or fails. */
export async function prepareLegacyCronOwnerHandoffs(params: {
  env: NodeJS.ProcessEnv;
  legacyDefaultAgentId: string;
  targets: readonly CronOwnerHandoffTarget[];
}): Promise<{ release: () => void }> {
  const handoffs: Array<ReturnType<typeof beginLegacyDefaultOwnerHandoff>> = [];
  const release = () => {
    for (const handoff of handoffs) {
      handoff.release();
    }
  };
  try {
    const { materializeLegacyDefaultCronJobOwners } =
      await import("../commands/doctor/cron/legacy-repair.js");
    for (const target of params.targets) {
      const handoff = beginLegacyDefaultOwnerHandoff({
        storePath: target.storePath,
        legacyDefaultAgentId: params.legacyDefaultAgentId,
      });
      handoffs.push(handoff);
      const liveMigration = await handoff.drainAndSeal();
      if (liveMigration.warnings.length > 0) {
        throw new Error(
          `Config write refused before live cron ownership was durable: ${liveMigration.warnings.join(" ")}`,
        );
      }
      const migration = await materializeLegacyDefaultCronJobOwners({
        cfg: target.config,
        storePath: target.storePath,
        env: params.env,
        legacyDefaultAgentId: params.legacyDefaultAgentId,
      });
      if (migration.warnings.length > 0) {
        throw new Error(
          `Config write refused before retired default ownership was durable: ${migration.warnings.join(" ")}`,
        );
      }
      await handoff.refreshSealedServices();
    }
    return { release };
  } catch (error) {
    release();
    throw error;
  }
}
