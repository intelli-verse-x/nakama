// ============================================================================
// Quest A/B overlay regression (allowlist + player/admin loader split)
// ----------------------------------------------------------------------------
//   node tests/quest_ab_overlay_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');
const persTs = readFileSync(join(base, 'src/hiro/personalizers/personalizers.ts'), 'utf8');
const questTs = readFileSync(join(base, 'src/quests/quest_engine.ts'), 'utf8');
const adminTs = readFileSync(join(base, 'src/hiro/base/admin.ts'), 'utf8');

const failures = [];
function check(name, cond) {
  if (cond) console.log('PASS  ' + name);
  else { console.log('FAIL  ' + name); failures.push(name); }
}

function fnBody(src, name) {
  const needle = 'function ' + name;
  const sig = src.indexOf(needle);
  if (sig < 0) return '';
  const open = src.indexOf('{', sig);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(sig, i + 1);
    }
  }
  return '';
}

const overlay = fnBody(persTs, 'applyQuestEngineOverlay');
const normalize = fnBody(persTs, 'normalizeVariantOverlay');
const personalize = fnBody(persTs, 'personalize');
const playerLoad = fnBody(questTs, 'loadPlayerConfig');
const adminGet = fnBody(questTs, 'rpcQuestEngineAdminGetConfig');
const adminSave = fnBody(questTs, 'rpcQuestEngineAdminSaveConfig');

check('allowlist includes reward/hidden/enabled/name/description',
  persTs.indexOf('QUEST_ENGINE_OVERLAY_ALLOWLIST') >= 0 &&
  /reward:\s*true/.test(persTs) &&
  /hidden:\s*true/.test(persTs) &&
  /enabled:\s*true/.test(persTs) &&
  /name:\s*true/.test(persTs) &&
  /description:\s*true/.test(persTs));
check('allowlist does not include steps/requiredCount/eventType',
  overlay.indexOf('steps') < 0 &&
  overlay.indexOf('requiredCount') < 0 &&
  overlay.indexOf('eventType') < 0);
check('normalize reads config || data',
  !!normalize && normalize.indexOf('variant.config || variant.data') >= 0);
check('unknown quest ids are skipped (no add)',
  overlay.indexOf('!config.quests.hasOwnProperty(questId)') >= 0);
check('reward is replaced, not mergeDeep',
  overlay.indexOf('dest.reward = deepClone(src.reward)') >= 0 &&
  overlay.indexOf('mergeDeep') < 0);
check('unsafe keys dropped',
  persTs.indexOf('__proto__') >= 0 && persTs.indexOf('constructor') >= 0);
check('fast path skips overlay when no running quest_engine experiment',
  personalize.indexOf('hasRunningConfigSystem') >= 0 &&
  (personalize.indexOf('QUEST_ENGINE_SYSTEM') >= 0 || personalize.indexOf('quest_engine') >= 0));
check('player get/record/claim use loadPlayerConfig',
  (questTs.split('loadPlayerConfig(nk, logger, userId, gameId)').length - 1) === 3);
check('admin get/save stay on raw loadConfig',
  adminGet.indexOf('loadConfig') >= 0 && adminGet.indexOf('loadPlayerConfig') < 0 &&
  adminSave.indexOf('persistAdminConfig') >= 0 && adminSave.indexOf('loadPlayerConfig') < 0 &&
  questTs.indexOf('function persistAdminConfig') >= 0 &&
  questTs.indexOf('var prev = loadConfig(nk, gameId);') >= 0 &&
  questTs.indexOf('persistAdminConfig') >= 0);
check('loadPlayerConfig calls HiroPersonalizers.personalize',
  playerLoad.indexOf('HiroPersonalizers.personalize') >= 0);

const setupFn = fnBody(adminTs, 'rpcExperimentSetup');
check('setup persists configSystem and goalMetric',
  setupFn.indexOf('configSystem:') >= 0 &&
  setupFn.indexOf('goalMetric:') >= 0 &&
  setupFn.indexOf('data.configSystem || data.config_system') >= 0);
check('setup persists canonical gameId on the experiment',
  setupFn.indexOf('gameId: gameId') >= 0);
check('quest_engine bans splitKey=random',
  setupFn.indexOf('splitKey=random') >= 0 &&
  setupFn.indexOf('QUEST_ENGINE_SYSTEM') >= 0);
check('one running quest_engine experiment per game',
  adminTs.indexOf('runningQuestEngineExperimentId') >= 0 &&
  setupFn.indexOf('Only one running quest_engine experiment per game') >= 0);
check('quest_engine setup aliases default gameId to QuizVerse UUID',
  adminTs.indexOf('canonicalExperimentGameId') >= 0 &&
  fnBody(adminTs, 'canonicalExperimentGameId').indexOf('QUIZVERSE_GAME_ID') >= 0);

const overlayVal = fnBody(adminTs, 'validateQuestEngineOverlay');
check('setup validates overlay against live quest ids',
  overlayVal.indexOf('unknown quest id') >= 0 &&
  overlayVal.indexOf('qv_quest_config') < 0 &&
  adminTs.indexOf('loadQuestConfigForGame') >= 0);
check('setup rejects forbidden overlay fields (steps)',
  overlayVal.indexOf('forbids field') >= 0 &&
  adminTs.indexOf('QUEST_ENGINE_OVERLAY_FIELDS') >= 0);
check('setup rejects overlay delete/null quests',
  overlayVal.indexOf('cannot delete quest') >= 0);
check('empty control overlay is allowed (same-prize recipe)',
  overlayVal.indexOf('if (!overlay.quests) continue') >= 0);
check('setup requires RewardEngine guaranteed reward',
  fnBody(adminTs, 'validateQuestEngineReward').indexOf('guaranteed') >= 0 &&
  fnBody(adminTs, 'validateQuestEngineReward').indexOf('RewardEngine.resolveReward') >= 0);
check('setup blocks overlay edits while running',
  setupFn.indexOf('cannot edit quest overlay while experiment is running') >= 0);
check('setup calls overlay validator before save',
  setupFn.indexOf('validateQuestEngineOverlay') >= 0 &&
  setupFn.indexOf('validateQuestEngineOverlay') < setupFn.indexOf('saveScopedSatoriConfig'));

const claimFn = fnBody(questTs, 'rpcQuestEngineClaimReward');
const getFn = fnBody(questTs, 'rpcQuestEngineGet');
const resetFn = fnBody(questTs, 'resetQuestProgress');
check('progress has rewardSnapshot field',
  questTs.indexOf('rewardSnapshot?: Hiro.Reward') >= 0);
check('first startedAt stamps rewardSnapshot',
  questTs.indexOf('stampRewardSnapshot(progress, qConfig.reward)') >= 0 &&
  questTs.indexOf('progress.startedAt = now') >= 0);
check('repeatable reset clears rewardSnapshot',
  resetFn.indexOf('rewardSnapshot = null') >= 0);
check('auto-grant uses effectiveReward snapshot',
  questTs.indexOf('var payoutReward = effectiveReward(progress, qConfig)') >= 0);
check('claim uses snapshot not live overlay',
  claimFn.indexOf('effectiveReward') >= 0 &&
  claimFn.indexOf('payReward') >= 0 &&
  claimFn.indexOf('resolveReward(nk, qConfig.reward)') < 0);
check('get rewardPreview uses snapshot when present',
  getFn.indexOf('rewardPreviewOf') >= 0);

const visFn = fnBody(questTs, 'isQuestVisible');
const claimFnT6 = fnBody(questTs, 'rpcQuestEngineClaimReward');
check('in-flight started or completed is always visible',
  visFn.indexOf('hasInFlightProgress') >= 0 &&
  visFn.indexOf('return true') >= 0);
check('unstarted hidden or disabled stays hidden',
  visFn.indexOf('isQuestEnabled') >= 0 &&
  visFn.indexOf('config.hidden') >= 0);
check('get uses in-flight visibility',
  getFn.indexOf('isQuestVisible') >= 0);
check('disabled overlay does not start new quests',
  questTs.indexOf('!isQuestEnabled(qConfig) && !hasInFlightProgress(progress)') >= 0);
check('claim ignores overlay hidden/enabled',
  claimFnT6.indexOf('isQuestVisible') < 0 &&
  claimFnT6.indexOf('isQuestEnabled') < 0 &&
  claimFnT6.indexOf('must not block a completed-unclaimed claim') >= 0);

const expTs = readFileSync(join(base, 'src/satori/experiments/experiments.ts'), 'utf8');
const variantFn = fnBody(expTs, 'getVariant');
const stampFn = fnBody(questTs, 'stampAbAttribution');
check('progress has abAttribution field',
  questTs.indexOf('abAttribution?: QuestAbAttribution') >= 0);
check('attribution first write wins',
  stampFn.indexOf('if (progress.abAttribution) return false') >= 0);
check('untracked quests are not stamped',
  stampFn.indexOf('isTrackedQuest') >= 0 &&
  fnBody(questTs, 'isTrackedQuest').indexOf('return false') >= 0);
check('get stamps attribution on returned tracked quests',
  getFn.indexOf('stampAbAttribution') >= 0);
check('get does not send experiment ids to Unity',
  getFn.indexOf('abAttribution:') < 0 &&
  getFn.indexOf('{ quests: result }') >= 0 &&
  getFn.indexOf('data.debug === true && isAdminCaller') >= 0);
check('first startedAt copies frozen attribution',
  questTs.indexOf('stampAbAttribution(progress, abCtx, questId, now)') >= 0);
check('repeatable reset clears abAttribution',
  resetFn.indexOf('abAttribution = null') >= 0);
check('getVariant reads assignment before audience',
  variantFn.indexOf('assignment.variantId') < variantFn.indexOf('isInAudience'));
check('new assignment freezes phaseId and configRevision',
  variantFn.indexOf('phaseId: currentPhaseId(def)') >= 0 &&
  variantFn.indexOf('configRevision: experimentConfigRevision(def)') >= 0);
check('setup persists configRevision and trackedQuestIds',
  setupFn.indexOf('configRevision:') >= 0 &&
  setupFn.indexOf('trackedQuestIds:') >= 0);
check('quest engine reads frozen experiment context',
  questTs.indexOf('getRunningQuestEngineAttribution') >= 0 &&
  expTs.indexOf('export function getRunningQuestEngineAttribution') >= 0);

const taxTs = readFileSync(join(base, 'src/satori/taxonomy/taxonomy.ts'), 'utf8');
const bridgeTs = readFileSync(join(base, 'src/satori/event-bus-bridge/satori-event-bus-bridge.ts'), 'utf8');
const resultsTs = readFileSync(join(base, 'src/satori/experiments/experiment-results.ts'), 'utf8');
const convertFn = fnBody(expTs, 'recordQuestCompletedConversion');
const markConvFn = fnBody(expTs, 'markQuestConvertedOcc');
check('taxonomy default includes quest_completed',
  taxTs.indexOf('quest_completed:') >= 0 &&
  taxTs.indexOf('"quest_completed"') >= 0);
check('taxonomy upserts missing default schema on capture',
  taxTs.indexOf('ensureDefaultSchema') >= 0 &&
  fnBody(taxTs, 'validateEvent').indexOf('ensureDefaultSchema') >= 0);
check('satori bridge subscribes quest_completed not step_completed',
  /EventBus\.Events\.QUEST_COMPLETED/.test(bridgeTs) &&
  !/EventBus\.Events\.QUEST_STEP_COMPLETED/.test(bridgeTs));
check('quest_completed emit carries frozen attribution',
  questTs.indexOf('emitData.experimentId = progress.abAttribution.experimentId') >= 0 &&
  questTs.indexOf('emitData.gameId = gameId') < 0 &&
  questTs.indexOf('userId: userId, questId: questId, gameId: gameId') >= 0);
check('conversion requires frozen gameId+experiment+variant+quest',
  convertFn.indexOf('!userId || !gameId || !questId || !experimentId || !variantId') >= 0);
check('conversion convertedAt is once per user',
  markConvFn.indexOf('if (assignment.convertedAt) return "already"') >= 0 &&
  convertFn.indexOf('mark !== "converted"') >= 0);
check('conversion bumps counter only after convertedAt',
  convertFn.indexOf('bumpConversionCounterOcc') > convertFn.indexOf('markQuestConvertedOcc'));
check('quest_completed results use convertedAt not unattributed events',
  resultsTs.indexOf('collectConvertedAt') >= 0 &&
  resultsTs.indexOf('goalEvent === "quest_completed"') >= 0);

check('funnel uses 32 shards from userId hash',
  expTs.indexOf('FUNNEL_SHARD_COUNT = 32') >= 0 &&
  expTs.indexOf('hash % FUNNEL_SHARD_COUNT') >= 0);
check('conversion counter is sharded not a single conv hot key',
  expTs.indexOf('funnel:" + experimentId + ":"') >= 0 &&
  expTs.indexOf('"conv:" + experimentId') < 0);
check('conversion bump writes completed step on user shard',
  convertFn.indexOf('bumpFunnelShardOcc') < 0 &&
  fnBody(expTs, 'bumpConversionCounterOcc').indexOf('bumpFunnelShardOcc') >= 0 &&
  fnBody(expTs, 'bumpConversionCounterOcc').indexOf('"completed"') >= 0);
check('results prefer 32 shard sums over assignment scan',
  resultsTs.indexOf('loadFunnelShardSums') >= 0 &&
  resultsTs.indexOf('shardsPresent') >= 0 &&
  resultsTs.indexOf('usedShards ? "shards"') >= 0);
check('results can rebuild shards from assignment markers',
  resultsTs.indexOf('rebuildFunnelShardsFromAssignments') >= 0 &&
  resultsTs.indexOf('data.reconcile === true') >= 0);
check('quest get records exposed funnel once',
  getFn.indexOf('recordAbFunnel') >= 0 &&
  getFn.indexOf('"exposed"') >= 0);
check('first start records started funnel',
  questTs.indexOf('recordAbFunnel(nk, logger, userId, progress, "started")') >= 0);
check('claim records claimed funnel',
  questTs.indexOf('recordAbFunnel(nk, logger, userId, peekProgress, "claimed")') >= 0);
check('first assignment bumps assigned shard',
  variantFn.indexOf('bumpFunnelShardOcc') >= 0 &&
  variantFn.indexOf('"assigned"') >= 0);
check('funnel steps stamp assignment markers once',
  expTs.indexOf('recordQuestFunnelStep') >= 0 &&
  expTs.indexOf('markAssignmentStampOcc') >= 0 &&
  expTs.indexOf('exposedAt') >= 0 &&
  expTs.indexOf('claimedAt') >= 0);
check('exposure funnel bump is after assignment OCC stamp',
  fnBody(expTs, 'recordQuestFunnelStep').indexOf('markAssignmentStampOcc') >= 0 &&
  fnBody(expTs, 'recordQuestFunnelStep').indexOf('bumpFunnelShardOcc') >
    fnBody(expTs, 'recordQuestFunnelStep').indexOf('markAssignmentStampOcc') &&
  fnBody(expTs, 'recordQuestFunnelStep').indexOf('mark !== "stamped"') >= 0);
check('setup persists minSamplePerArm',
  setupFn.indexOf('minSamplePerArm') >= 0);
check('results require min sample before suggestedWinner',
  resultsTs.indexOf('MIN_SAMPLE_QA = 30') >= 0 &&
  resultsTs.indexOf('MIN_SAMPLE_LIVE = 100') >= 0 &&
  resultsTs.indexOf('if (!sampleMet)') >= 0 &&
  resultsTs.indexOf('winner = null') >= 0);
check('quest results count exposed not assigned when exposed ticks exist',
  resultsTs.indexOf('countMapTotal(shardSums.exposed) > 0') >= 0 &&
  resultsTs.indexOf('exposures = shardSums.exposed') >= 0);
check('results compute chi-square SRM vs variant weights',
  resultsTs.indexOf('SRM_ALPHA = 0.001') >= 0 &&
  resultsTs.indexOf('function computeSrm') >= 0 &&
  resultsTs.indexOf('chiSquareSurvival') >= 0);
check('SRM fail blocks suggestedWinner do not promote',
  resultsTs.indexOf('srmPassed') >= 0 &&
  resultsTs.indexOf('Do not promote: sample ratio mismatch') >= 0 &&
  resultsTs.indexOf('srm: srm') >= 0);

const declareFn = fnBody(resultsTs, 'rpcDeclareWinner');
check('runPromoteStep prepare/write/verify exists',
  questTs.indexOf('export function runPromoteStep') >= 0 &&
  questTs.indexOf('if (step === "prepare")') >= 0 &&
  questTs.indexOf('if (step === "write")') >= 0 &&
  questTs.indexOf('if (step === "verify")') >= 0);
check('promote snapshots previous and desired into quest audit',
  questTs.indexOf('QUEST_CONFIG_AUDIT_COLLECTION') >= 0 &&
  questTs.indexOf('promotion: true') >= 0 &&
  questTs.indexOf('previous: rec.config') >= 0 &&
  questTs.indexOf('desired: desired') >= 0);
check('promote write uses OCC and skips if hash already matches',
  questTs.indexOf('function saveConfigOcc') >= 0 &&
  questTs.indexOf('quest config changed during promote; retry') >= 0 &&
  questTs.indexOf('hashQuestsConfig(live.config)') >= 0);
check('winner overlay reuses applyQuestEngineOverlay',
  questTs.indexOf('HiroPersonalizers.applyQuestEngineOverlay') >= 0 &&
  persTs.indexOf('export function applyQuestEngineOverlay') >= 0);
check('declare promote=true only for quest_engine',
  declareFn.indexOf('data.promote === true') >= 0 &&
  declareFn.indexOf('configSystem === "quest_engine"') >= 0 &&
  declareFn.indexOf('QuestEngine.runPromoteStep') >= 0);
check('promote is blocked by SRM and min-sample',
  declareFn.indexOf('promoteGateError') >= 0 &&
  resultsTs.indexOf('cannot promote: sample ratio mismatch') >= 0 &&
  resultsTs.indexOf('cannot promote: need at least') >= 0);
check('quest write failure does not end the experiment',
  declareFn.indexOf('promote write failed') < declareFn.indexOf('def.status = "ended"') &&
  declareFn.indexOf('promote verify failed') < declareFn.indexOf('def.status = "ended"'));
check('promote response includes promoted and auditKey',
  declareFn.indexOf('promoted: true') >= 0 &&
  declareFn.indexOf('auditKey:') >= 0 &&
  declareFn.indexOf('status: "ended"') >= 0);
check('promote:false is kill switch (end only)',
  declareFn.indexOf('promoted: false') >= 0);
check('admin declare sends promote:true for quest_engine',
  (() => {
    const ui = readFileSync(join(base, '../../web/packages/admin/src/pages/ExperimentsPage.tsx'), 'utf8');
    return ui.indexOf('configSystem === "quest_engine"') >= 0 &&
      ui.indexOf('promote: true') >= 0 &&
      ui.indexOf('winning sticker onto the real quest list') >= 0;
  })());
check('declareExperimentWinner accepts promote flag',
  (() => {
    const rpcTs = readFileSync(join(base, '../../web/packages/shared/src/rpc/satori/index.ts'), 'utf8');
    return rpcTs.indexOf('promote?: boolean') >= 0;
  })());

check('admin save writes through persistAdminConfig',
  fnBody(questTs, 'rpcQuestEngineAdminSaveConfig').indexOf('persistAdminConfig') >= 0 &&
  questTs.indexOf('function persistAdminConfig') >= 0);
check('restorePromoteAudit reads previous from promote audit',
  questTs.indexOf('export function restorePromoteAudit') >= 0 &&
  questTs.indexOf('promote audit snapshot missing') >= 0 &&
  questTs.indexOf('audit.previous') >= 0 &&
  questTs.indexOf('persistAdminConfig(nk, ctx, logger, gameId, previous') >= 0);
check('restore is no-op when live already matches previous',
  questTs.indexOf('liveHash === prevHash') >= 0 &&
  questTs.indexOf('already: true') >= 0);
check('restore refuses if live quest list changed after promote',
  questTs.indexOf('quest list changed after promote; cannot restore') >= 0);
check('undo promote RPC restores then keeps experiment ended',
  resultsTs.indexOf('satori_experiments_undo_promote') >= 0 &&
  fnBody(resultsTs, 'rpcUndoPromote').indexOf('QuestEngine.restorePromoteAudit') >= 0 &&
  fnBody(resultsTs, 'rpcUndoPromote').indexOf('status = "running"') < 0 &&
  fnBody(resultsTs, 'rpcUndoPromote').indexOf('def.promotion.restored = true') >= 0);
check('admin list and results expose promote auditKey',
  adminTs.indexOf('auditKey: def.promotion.auditKey') >= 0 &&
  resultsTs.indexOf('auditKey: def.promotion.auditKey') >= 0);
check('admin undo button restores old quest list',
  (() => {
    const ui = readFileSync(join(base, '../../web/packages/admin/src/pages/ExperimentsPage.tsx'), 'utf8');
    const rpcTs = readFileSync(join(base, '../../web/packages/shared/src/rpc/satori/index.ts'), 'utf8');
    return ui.indexOf('undoExperimentPromote') >= 0 &&
      ui.indexOf('Undo — put old quest list back') >= 0 &&
      ui.indexOf('Put the old quest list back?') >= 0 &&
      rpcTs.indexOf('satori_experiments_undo_promote') >= 0;
  })());

const mergeTs = readFileSync(join(base, 'src/identity/quizverse_merge.ts'), 'utf8');
check('guest merge ports satori_assignments copy-if-absent',
  fnBody(mergeTs, 'portCollections').indexOf('SATORI_ASSIGNMENTS_COLLECTION') >= 0 &&
  mergeTs.indexOf('satori_assignments') >= 0);
check('merge port is copy-if-absent (destination never overwritten)',
  mergeTs.indexOf('if (existing && existing.length > 0) continue') >= 0);

check('player RPCs require gameId (missing does not steal QuizVerse)',
  fnBody(questTs, 'resolveGameId').indexOf('RpcHelpers.gameId(data) || Constants.QUIZVERSE_GAME_ID') < 0 &&
  questTs.indexOf('gameId required (registry UUID)') >= 0);
check('default still aliases to QuizVerse UUID',
  fnBody(questTs, 'resolveGameId').indexOf('DEFAULT_GAME_ID') >= 0 &&
  fnBody(questTs, 'resolveGameId').indexOf('QUIZVERSE_GAME_ID') >= 0);
check('quest_engine setup requires gameId and does not map empty to QuizVerse',
  setupFn.indexOf('gameId required (registry UUID)') >= 0 &&
  fnBody(adminTs, 'canonicalExperimentGameId').indexOf('!id ||') < 0);
check('event bus skips events without gameId',
  (() => {
    const bridge = readFileSync(join(base, 'src/quests/quest-eventbus-bridge.ts'), 'utf8');
    return fnBody(bridge, 'resolveQuestGameId').indexOf('QUIZVERSE_GAME_ID') >= 0 &&
      fnBody(bridge, 'handleEvent').indexOf('skip event without gameId') >= 0 &&
      fnBody(bridge, 'resolveQuestGameId').indexOf(': Constants.QUIZVERSE_GAME_ID') < 0;
  })());
check('personalizer preview loads quest_engine from QuestEngine.loadRawConfig',
  persTs.indexOf('QuestEngine.loadRawConfig') >= 0 &&
  fnBody(persTs, 'rpcPreviewConfig').indexOf('system === QUEST_ENGINE_SYSTEM') >= 0 &&
  fnBody(persTs, 'rpcPreviewConfig').indexOf('gameId required') >= 0);
check('quest_engine get debug.experiment is admin-only',
  fnBody(questTs, 'rpcQuestEngineGet').indexOf('data.debug === true') >= 0 &&
  fnBody(questTs, 'rpcQuestEngineGet').indexOf('isAdminCaller') >= 0 &&
  fnBody(questTs, 'rpcQuestEngineGet').indexOf('payloadOut.debug') >= 0);
check('first assign and promote emit structured quest_ab logs',
  fnBody(expTs, 'getVariant').indexOf('[quest_ab] assigned') >= 0 &&
  resultsTs.indexOf('[quest_ab] promote') >= 0);
check('quests page preview as user uses existing personalizer preview',
  (() => {
    const ui = readFileSync(join(base, '../../web/packages/admin/src/pages/QuestsConfigPage.tsx'), 'utf8');
    const hiroTs = readFileSync(join(base, '../../web/packages/shared/src/rpc/hiro/index.ts'), 'utf8');
    const guide = readFileSync(join(base, '../../web/packages/admin/src/pages/DevGuidePage.tsx'), 'utf8');
    const onboard = readFileSync(join(base, '../../GAME_ONBOARDING_GUIDE.md'), 'utf8');
    return ui.indexOf('previewPersonalizer') >= 0 &&
      ui.indexOf('Preview as user') >= 0 &&
      hiroTs.indexOf('hiro_personalizer_preview') >= 0 &&
      guide.indexOf('configSystem=quest_engine') >= 0 &&
      onboard.indexOf("Quest A/B (existing quest engine)") >= 0;
  })());

check("quests page A/B wizard is two recipes only",
  (() => {
    const panel = readFileSync(join(base, "../../web/packages/admin/src/components/QuestAbPanel.tsx"), "utf8");
    const ui = readFileSync(join(base, "../../web/packages/admin/src/pages/QuestsConfigPage.tsx"), "utf8");
    return panel.indexOf('type Recipe = "reward" | "vs"') >= 0 &&
      panel.indexOf("Same quest, different prize") >= 0 &&
      panel.indexOf("This quest vs that quest") >= 0 &&
      panel.indexOf("RewardBuilder") >= 0 &&
      panel.indexOf('configSystem: "quest_engine"') >= 0 &&
      panel.indexOf("Save the other quest first") >= 0 &&
      panel.indexOf("Promote writes the winning sticker onto the real quest list") >= 0 &&
      ui.indexOf("QuestAbPanel") >= 0 &&
      ui.indexOf("A/B this") >= 0;
  })());

check("quests page A/B results show funnel, rates, sparkline, undo, SLO",
  (() => {
    const panel = readFileSync(join(base, "../../web/packages/admin/src/components/QuestAbPanel.tsx"), "utf8");
    return panel.indexOf("<th className=\"py-1 pr-2\">Assigned</th>") >= 0 &&
      panel.indexOf("<th className=\"py-1 pr-2\">Exposed</th>") >= 0 &&
      panel.indexOf("<th className=\"py-1 pr-2\">Started</th>") >= 0 &&
      panel.indexOf("<th className=\"py-1 pr-2\">Completed</th>") >= 0 &&
      panel.indexOf("<th className=\"py-1 pr-2\">Claimed</th>") >= 0 &&
      panel.indexOf("exposed/assigned") >= 0 &&
      panel.indexOf("started/exposed") >= 0 &&
      panel.indexOf("completed/started") >= 0 &&
      panel.indexOf("claimed/completed") >= 0 &&
      panel.indexOf("Lift vs control") >= 0 &&
      panel.indexOf("data.srm") >= 0 &&
      panel.indexOf("data.minSample") >= 0 &&
      panel.indexOf("assignmentsTruncated") >= 0 &&
      panel.indexOf("eventsTruncated") >= 0 &&
      panel.indexOf("sparklineRows") >= 0 &&
      panel.indexOf("LineChart") >= 0 &&
      panel.indexOf("undoExperimentPromote") >= 0 &&
      panel.indexOf("This writes the winning sticker onto the real quest list") >= 0 &&
      panel.indexOf("Pause can take up to 1 minute to reach every server") >= 0;
  })());

check("QA then 10% prod checklist lives in onboarding + DevGuide + live RPC harness",
  (() => {
    const onboard = readFileSync(join(base, "../../GAME_ONBOARDING_GUIDE.md"), "utf8");
    const guide = readFileSync(join(base, "../../web/packages/admin/src/pages/DevGuidePage.tsx"), "utf8");
    const live = readFileSync(join(base, "tests/quest_ab_overlay_live_rpc.mjs"), "utf8");
    return onboard.indexOf("QA audience first") >= 0 &&
      onboard.indexOf("10% test / 90% control") >= 0 &&
      onboard.indexOf("quest_ab_overlay_live_rpc.mjs") >= 0 &&
      guide.indexOf("QA audience first") >= 0 &&
      guide.indexOf("10% test / 90% control") >= 0 &&
      live.indexOf("NAKAMA_EVAL_ALLOW_REMOTE") >= 0 &&
      live.indexOf("quest_engine_get") >= 0 &&
      live.indexOf("user B lands on the other variant") >= 0;
  })());

if (failures.length > 0) {
  console.error('\nQUEST A/B OVERLAY: FAIL — ' + failures.join(' | '));
  process.exit(1);
}
console.log('\nQUEST A/B OVERLAY: PASS');
