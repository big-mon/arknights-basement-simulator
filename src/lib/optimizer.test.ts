import { describe, expect, it } from "vitest";
import baseSkillOverrides from "../data/base-skill-overrides.json";
import { createDefaultState, createFacilitiesForLayout, operators } from "../data/defaults";
import { exportState, importState } from "./storage";
import {
  attachRotationAlternatives,
  activeBaseSkills,
  conditionsSatisfied,
  findCandidates,
  generateAssignmentPlan,
  registeredComplexBaseSkillHandlerKeys
} from "./optimizer";
import type { Assignment, FacilityPlan, FacilitySlot } from "../types";

const factoryEliteLockedOperator = operators.find((operator) =>
  operator.skills.some(
    (skill) =>
      skill.unlockPhase > 0 &&
      skill.effects.some((effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold"))
  )
)!;
const factoryEliteLockedSkill = factoryEliteLockedOperator.skills.find(
  (skill) =>
    skill.unlockPhase > 0 &&
    skill.effects.some((effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold"))
)!;
const defaultOwnedGoldFactoryOperator = operators.find((operator) =>
  operator.rarity <= 4 &&
  operator.skills.some(
    (skill) =>
      skill.unlockPhase === 0 &&
      skill.effects.some(
        (effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold") && !effect.suppressesOtherFactoryEfficiency
      )
  )
)!;
const defaultOwnedTradingOperator = operators.find((operator) =>
  operator.rarity <= 4 &&
  operator.skills.some(
    (skill) =>
      skill.unlockPhase === 0 &&
      skill.effects.some(
        (effect) =>
          effect.facility === "trading" &&
          (!effect.product || effect.product === "lmd") &&
          !effect.ignoredForOptimization &&
          !effect.conditions?.length
      )
  )
)!;
const texas = operators.find((operator) => operator.id === "char_102_texas")!;
const lappland = operators.find((operator) => operator.id === "char_140_whitew")!;
const texasLapplandSkill = texas.skills.find((skill) => skill.id === "trade_ord_spd&cost_P[000]")!;
const threeStarOperator = operators.find((operator) => operator.rarity === 3)!;
const lowRarityOperator = operators.find((operator) => operator.rarity <= 2)!;
const lowRarityPowerOperator = operators.find(
  (operator) =>
    operator.rarity <= 2 &&
    operator.skills.some((skill) =>
      skill.effects.some((effect) => effect.facility === "power" && (!effect.product || effect.product === "power"))
    )
)!;
const eyjafjalla = operators.find((operator) => operator.id === "char_180_amgoat")!;
const amiya = operators.find((operator) => operator.id === "char_002_amiya")!;
const lava = operators.find((operator) => operator.id === "char_121_lava")!;
const leto = operators.find((operator) => operator.id === "char_194_leto")!;
const gummy = operators.find((operator) => operator.id === "char_196_sunbr")!;
const letoGummySkill = leto.skills.find((skill) => skill.id === "manu_formula_spd_P[000]")!;
const delphine = operators.find((operator) => operator.id === "char_4110_delphn")!;
const glasgowOperator = operators.find((operator) => operator.id === "char_154_morgan")!;
const delphineGlasgowSkill = delphine.skills.find((skill) => skill.id === "control_tra_limit&spd[010]")!;
const gladiia = operators.find((operator) => operator.id === "char_474_glady")!;
const andreana = operators.find((operator) => operator.id === "char_218_cuttle")!;
const chen = operators.find((operator) => operator.id === "char_010_chen")!;
const swire = operators.find((operator) => operator.id === "char_308_swire")!;
const morgan = operators.find((operator) => operator.id === "char_154_morgan")!;
const siege = operators.find((operator) => operator.id === "char_112_siege")!;
const morganGlasgowSkill = morgan.skills.find((skill) => skill.id === "trade_ord_spd_par[000]")!;
const typhon = operators.find((operator) => operator.id === "char_2012_typhon")!;
const valarqvin = operators.find((operator) => operator.id === "char_4102_threye")!;
const rosa = operators.find((operator) => operator.id === "char_197_poca")!;
const zima = operators.find((operator) => operator.id === "char_115_headbr")!;
const lemuen = operators.find((operator) => operator.id === "char_4193_lemuen")!;
const exusiai = operators.find((operator) => operator.id === "char_103_angel")!;
const lemuenExusiaiSkill = lemuen.skills.find((skill) => skill.id === "trade_ord_spd&multiPar[100]")!;
const muelsyse = operators.find((operator) => operator.id === "char_249_mlyss")!;
const saria = operators.find((operator) => operator.id === "char_202_demkni")!;
const eunectes = operators.find((operator) => operator.id === "char_416_zumama")!;
const windflit = operators.find((operator) => operator.id === "char_433_windft")!;
const silverashAlter = operators.find((operator) => operator.id === "char_1045_svash2")!;
const pramanix = operators.find((operator) => operator.id === "char_174_slbell")!;
const courier = operators.find((operator) => operator.id === "char_198_blackd")!;
const thirdKjeragOperator = operators.find(
  (operator) =>
    operator.id !== silverashAlter.id &&
    operator.id !== pramanix.id &&
    operator.id !== courier.id &&
    operator.affiliations?.includes("kjerag")
)!;
const gnosis = operators.find((operator) => operator.id === "char_206_gnosis")!;
const hedley = operators.find((operator) => operator.id === "char_4088_hodrer")!;
const ines = operators.find((operator) => operator.id === "char_4087_ines")!;
const w = operators.find((operator) => operator.id === "char_113_cqbw")!;
const underflow = operators.find((operator) => operator.id === "char_4137_udflow")!;
const ulpianus = operators.find((operator) => operator.id === "char_4145_ulpia")!;
const snegurochka = operators.find((operator) => operator.id === "char_4208_wintim")!;
const vulpisfoglia = operators.find((operator) => operator.id === "char_4026_vulpis")!;
const suzuran = operators.find((operator) => operator.id === "char_358_lisa")!;
const vulpisfogliaSuzuranSkill = vulpisfoglia.skills.find((skill) => skill.id === "meet_spd&bd[100]")!;
const ash = operators.find((operator) => operator.id === "char_456_ash")!;
const blitz = operators.find((operator) => operator.id === "char_457_blitz")!;
const tachanka = operators.find((operator) => operator.id === "char_459_tachak")!;
const wisadel = operators.find((operator) => operator.id === "char_1035_wisdel")!;
const wisadelHedleySkill = wisadel.skills.find((skill) => skill.id === "control_meeting&ord[000]")!;
const fang = operators.find((operator) => operator.id === "char_123_fang")!;
const lee = operators.find((operator) => operator.id === "char_322_lmlee")!;
const may = operators.find((operator) => operator.id === "char_133_mm")!;
const yatoAlter = operators.find((operator) => operator.id === "char_1029_yato2")!;
const terraResearchCommission = operators.find((operator) => operator.id === "char_4077_palico")!;
const iana = operators.find((operator) => operator.id === "char_4124_iana")!;
const bibeak = operators.find((operator) => operator.id === "char_252_bibeak")!;
const ascalon = operators.find((operator) => operator.id === "char_4132_ascln")!;
const saileach = operators.find((operator) => operator.id === "char_479_sleach")!;
const kaltsit = operators.find((operator) => operator.id === "char_003_kalts")!;
const archetto = operators.find((operator) => operator.id === "char_332_archet")!;
const minimalist = operators.find((operator) => operator.id === "char_4054_malist")!;
const greyyAlter = operators.find((operator) => operator.id === "char_1027_greyy2")!;
const pozemka = operators.find((operator) => operator.id === "char_4055_bgsnow")!;
const kirara = operators.find((operator) => operator.id === "char_478_kirara")!;
const waaiFu = operators.find((operator) => operator.id === "char_243_waaifu")!;
const shu = operators.find((operator) => operator.id === "char_2025_shu")!;
const alanna = operators.find((operator) => operator.id === "char_4178_alanna")!;
const lancet = operators.find((operator) => operator.id === "char_285_medic2")!;
const justiceKnight = operators.find((operator) => operator.id === "char_4000_jnight")!;
const vigil = operators.find((operator) => operator.id === "char_427_vigil")!;
const vermeil = operators.find((operator) => operator.id === "char_190_clour")!;
const bena = operators.find((operator) => operator.id === "char_369_bena")!;
const bubble = operators.find((operator) => operator.id === "char_381_bubble")!;
const asbestos = operators.find((operator) => operator.id === "char_378_asbest")!;
const wulfenite = operators.find((operator) => operator.id === "char_4171_wulfen")!;
const jessicaAlter = operators.find((operator) => operator.id === "char_1034_jesca2")!;
const flametail = operators.find((operator) => operator.id === "char_420_flamtl")!;
const blacksteelFactoryOperator = operators.find(
  (operator) =>
    operator.id !== jessicaAlter.id &&
    operator.affiliations?.includes("blacksteel") &&
    operator.skills.some((skill) => skill.effects.some((effect) => effect.facility === "factory"))
)!;
const pinusFactoryOperator = operators.find(
  (operator) =>
    operator.id !== flametail.id &&
    operator.affiliations?.includes("pinus") &&
    operator.skills.some((skill) => skill.effects.some((effect) => effect.facility === "factory"))
)!;
const degenbrecher = operators.find((operator) => operator.id === "char_4116_blkkgt")!;
const matterhorn = operators.find((operator) => operator.id === "char_199_yak")!;
const obliviator = operators.find((operator) => operator.id === "char_4182_oblvns")!;
const mortis = operators.find((operator) => operator.id === "char_4183_mortis")!;
const mrNothing = operators.find((operator) => operator.id === "char_455_nothin")!;
const weedy = operators.find((operator) => operator.id === "char_400_weedy")!;
const vulcan = operators.find((operator) => operator.id === "char_163_hpsts")!;
const warmy = operators.find((operator) => operator.id === "char_4081_warmy")!;
const totter = operators.find((operator) => operator.id === "char_4062_totter")!;
const levelLockedOperator = operators.find((operator) => operator.skills.some((skill) => skill.unlockLevel > 1))!;
const levelLockedSkill = levelLockedOperator.skills.find((skill) => skill.unlockLevel > 1)!;

function ownBaselineRoster(state: ReturnType<typeof createDefaultState>) {
  for (const operator of operators) {
    if (operator.rarity <= 4) {
      state.roster[operator.id].owned = true;
      state.roster[operator.id].elite = operator.rarity <= 3 ? 1 : 0;
    }
  }
}

function ownAllRoster(state: ReturnType<typeof createDefaultState>) {
  for (const operator of operators) {
    state.roster[operator.id].owned = true;
    state.roster[operator.id].elite = operator.rarity <= 2 ? 0 : operator.rarity === 3 ? 1 : 2;
  }
}

function ownOperators(state: ReturnType<typeof createDefaultState>, operatorIds: string[]) {
  for (const operatorId of operatorIds) {
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
  }
}

function contextAssignment(facility: FacilitySlot, operatorId: string, patch: Partial<Assignment> = {}): Assignment {
  return {
    facilityId: facility.id,
    operatorId,
    skillId: "context",
    score: 0,
    efficiency: 0,
    fatigueHours: 0,
    recoveryHours: 0,
    reason: "context",
    ...patch
  };
}

function assignmentsForFacilitySlots(assignments: Assignment[], slotCount: number): Assignment[] {
  const selected: Assignment[] = [];
  let occupiedSlots = 0;

  for (const assignment of assignments) {
    if (assignment.doesNotConsumeFacilitySlot) {
      selected.push(assignment);
      continue;
    }
    if (occupiedSlots < slotCount) {
      selected.push(assignment);
      occupiedSlots += 1;
    }
  }

  return selected;
}

function productWeightForTest(product: FacilitySlot["product"], preference: ReturnType<typeof createDefaultState>["preference"]) {
  if (product === "gold") {
    return preference.gold;
  }
  if (product === "battleRecord") {
    return preference.battleRecord;
  }
  if (product === "originium") {
    return 0.05;
  }
  if (product === "lmd") {
    return preference.lmd;
  }
  if (product === "power") {
    return (preference.gold + preference.battleRecord + preference.lmd) / 3;
  }
  return 0.2;
}

describe("optimizer", () => {
  it("honors level requirements in addition to elite phase", () => {
    const belowRequirement = activeBaseSkills(
      levelLockedOperator,
      levelLockedSkill.unlockPhase,
      levelLockedSkill.unlockLevel - 1
    );
    const atRequirement = activeBaseSkills(
      levelLockedOperator,
      levelLockedSkill.unlockPhase,
      levelLockedSkill.unlockLevel
    );

    expect(belowRequirement.map((skill) => skill.id)).not.toContain(levelLockedSkill.id);
    expect(atRequirement.map((skill) => skill.id)).toContain(levelLockedSkill.id);
  });

  it("replaces lower skill tiers per slot and combines different active slots", () => {
    const activeSkills = activeBaseSkills(alanna, 2, 1);

    expect(activeSkills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(["manu_token_prod_spd[010]", "manu_prod_spd_double[000]"])
    );
    expect(activeSkills.map((skill) => skill.id)).not.toContain("manu_token_prod_spd[000]");

    const state = createDefaultState();
    ownOperators(state, [alanna.id, warmy.id, lancet.id, justiceKnight.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    const candidate = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [
        contextAssignment(factory, warmy.id),
        contextAssignment(power, lancet.id),
        contextAssignment(power, justiceKnight.id)
      ],
      roster: state.roster
    }).find((assignment) => assignment.operatorId === alanna.id)!;

    expect(candidate.skillId.split("+")).toEqual(
      expect.arrayContaining(["manu_token_prod_spd[010]", "manu_prod_spd_double[000]"])
    );
    expect(candidate.efficiency).toBeCloseTo(0.35);
  });

  it("uses two gold and two battle record factories for balanced 243 layout", () => {
    const state = createDefaultState();
    const factoryProducts = state.facilities.filter((facility) => facility.type === "factory").map((facility) => facility.product);

    expect(factoryProducts).toEqual(["gold", "gold", "battleRecord", "battleRecord"]);
  });

  it("migrates the legacy balanced factory split to two gold factories", () => {
    const legacyFacilities: FacilitySlot[] = [
      { id: "factory-1", type: "factory", name: "Factory A", slotCount: 3, product: "gold" },
      { id: "factory-2", type: "factory", name: "Factory B", slotCount: 3, product: "battleRecord" },
      { id: "factory-3", type: "factory", name: "Factory C", slotCount: 3, product: "battleRecord" },
      { id: "factory-4", type: "factory", name: "Factory D", slotCount: 3, product: "battleRecord" }
    ];
    const factoryProducts = createFacilitiesForLayout("243", legacyFacilities)
      .filter((facility) => facility.type === "factory")
      .map((facility) => facility.product);

    expect(factoryProducts).toEqual(["gold", "gold", "battleRecord", "battleRecord"]);
  });

  it("filters candidates by facility type and unlocked elite phase", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidates = findCandidates(factory, state);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.facilityId === factory.id)).toBe(true);
    expect(candidates.some((candidate) => candidate.operatorId === factoryEliteLockedOperator.id)).toBe(false);

    state.roster[factoryEliteLockedOperator.id] = {
      ...state.roster[factoryEliteLockedOperator.id],
      owned: true,
      elite: factoryEliteLockedSkill.unlockPhase
    };

    expect(findCandidates(factory, state).some((candidate) => candidate.operatorId === factoryEliteLockedOperator.id)).toBe(true);
  });

  it("changes score priority when material weights change", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const baselinePlan = generateAssignmentPlan(state);
    const baselineGoldScore = baselinePlan.facilityPlans.find((plan) => plan.facility.id === "factory-1")!.score;

    state.preference = { gold: 1, battleRecord: 0.05, lmd: 0.05 };
    const goldFocusedPlan = generateAssignmentPlan(state);
    const goldFocusedScore = goldFocusedPlan.facilityPlans.find((plan) => plan.facility.id === "factory-1")!.score;

    expect(goldFocusedScore).toBeGreaterThan(baselineGoldScore);
  });

  it("requires named operators in the same facility for same-room conditional skills", () => {
    const state = createDefaultState();
    ownOperators(state, [texas.id, lappland.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(findCandidates(trading, state).some((candidate) => candidate.skillId === texasLapplandSkill.id)).toBe(false);
    expect(
      findCandidates(trading, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, lappland.id)]
      }).some((candidate) => candidate.skillId === texasLapplandSkill.id)
    ).toBe(true);
  });

  it("requires named operators in referenced facilities for cross-facility conditional skills", () => {
    const state = createDefaultState();
    ownOperators(state, [leto.id, gummy.id]);
    const factory = state.facilities.find((facility) => facility.type === "factory" && facility.product === "battleRecord")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(factory.product).toBe("battleRecord");
    expect(findCandidates(factory, state).some((candidate) => candidate.skillId === letoGummySkill.id)).toBe(false);
    expect(
      findCandidates(factory, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, gummy.id)]
      }).some((candidate) => candidate.skillId === letoGummySkill.id)
    ).toBe(true);
  });

  it("requires matching affiliation operators for faction conditional skills", () => {
    const state = createDefaultState();
    ownOperators(state, [delphine.id, glasgowOperator.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const delphineWithGlasgow = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, glasgowOperator.id)]
    }).find((candidate) => candidate.skillId === delphineGlasgowSkill.id)!;

    expect(glasgowOperator.affiliations).toContain("glasgow");
    expect(findCandidates(control, state).some((candidate) => candidate.skillId === delphineGlasgowSkill.id)).toBe(false);
    expect(delphineWithGlasgow).toBeDefined();
    expect(delphineWithGlasgow.efficiency).toBe(0);
    expect(delphineWithGlasgow.remoteFacilityEfficiencyBonuses).toContainEqual({
      facility: "trading",
      amount: 0.1,
      product: "lmd",
      affiliations: ["glasgow"],
      min: 1
    });
  });

  it("applies Delphine's Glasgow boost to matching trading posts", () => {
    const state = createDefaultState();
    ownOperators(state, [delphine.id, glasgowOperator.id]);
    state.facilities = state.facilities.filter((facility) => facility.id === "control-1" || facility.id === "trading-1");
    const plan = generateAssignmentPlan(state);
    const tradingPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "trading-1")!;
    const controlPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "control-1")!;
    const assignedEfficiency = tradingPlan.assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);

    expect(controlPlan.assignments.some((assignment) => assignment.operatorId === delphine.id)).toBe(true);
    expect(tradingPlan.assignments.some((assignment) => assignment.operatorId === glasgowOperator.id)).toBe(true);
    expect(tradingPlan.expectedEfficiency - assignedEfficiency).toBeCloseTo(0.1);
  });

  it("keeps Abyssal Hunter affiliation data without gating Gladiia's control recovery effect", () => {
    expect(gladiia.affiliations).toEqual(expect.arrayContaining(["egir", "abyssal"]));
    expect(andreana.affiliations).toContain("abyssal");

    const groupHuntingEffects = gladiia.skills
      .filter((skill) => skill.id.startsWith("control_mp_aegir2"))
      .flatMap((skill) => skill.effects);

    expect(groupHuntingEffects.length).toBe(2);
    expect(
      groupHuntingEffects.every(
        (effect) =>
          !effect.conditions?.some(
            (condition) => "affiliations" in condition && condition.affiliations.includes("abyssal")
          )
      )
    ).toBe(true);
  });

  it("keeps Gladiia eligible as a control center recovery candidate", () => {
    const state = createDefaultState();
    ownOperators(state, [gladiia.id, andreana.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const gladiiaCandidate = findCandidates(control, state).find((candidate) => candidate.operatorId === gladiia.id)!;

    expect(gladiiaCandidate.facilityId).toBe(control.id);
    expect(gladiiaCandidate.efficiency).toBeCloseTo(0.05);
  });

  it("scales Chen's control recovery by LGD operators in the control center", () => {
    const state = createDefaultState();
    ownOperators(state, [chen.id, swire.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const chenBase = findCandidates(control, state).find((candidate) => candidate.operatorId === chen.id)!;
    const chenWithLgd = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, swire.id)]
    }).find((candidate) => candidate.operatorId === chen.id)!;

    expect(chen.affiliations).toContain("lgd");
    expect(swire.affiliations).toContain("lgd");
    expect(chenBase.efficiency).toBeCloseTo(0.05);
    expect(chenWithLgd.efficiency).toBeCloseTo(0.1);
  });

  it("scales Rainbow control recovery by Rainbow operators in the control center", () => {
    const state = createDefaultState();
    ownOperators(state, [ash.id, blitz.id, tachanka.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const ashBase = findCandidates(control, state).find((candidate) => candidate.operatorId === ash.id)!;
    const ashWithRainbowSquad = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, blitz.id), contextAssignment(control, tachanka.id)]
    }).find((candidate) => candidate.operatorId === ash.id)!;

    expect(ash.affiliations).toContain("rainbow");
    expect(blitz.affiliations).toContain("rainbow");
    expect(tachanka.affiliations).toContain("rainbow");
    expect(ashBase.efficiency).toBeCloseTo(0.05);
    expect(ashWithRainbowSquad.efficiency).toBeCloseTo(0.15);
  });

  it("models Wis'adel's Hoederer and Ines control-center branches independently", () => {
    const state = createDefaultState();
    ownOperators(state, [wisadel.id, hedley.id, ines.id]);
    state.roster[wisadel.id].elite = 0;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const reception: FacilitySlot = { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" };
    const facilities = [...state.facilities, reception];

    expect(findCandidates(control, state).some((candidate) => candidate.skillId === wisadelHedleySkill.id)).toBe(false);
    expect(
      findCandidates(control, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, hedley.id)]
      }).some((candidate) => candidate.skillId === wisadelHedleySkill.id)
    ).toBe(true);
    const withInesReception = findCandidates(control, state, 0, {
      facilities,
      assignments: [contextAssignment(reception, ines.id)]
    }).find((candidate) => candidate.skillId === wisadelHedleySkill.id)!;

    expect(withInesReception.score).toBeGreaterThan(0);
    expect(withInesReception.remoteFacilityStatBonuses).toBeUndefined();
    expect(withInesReception.globalStackKey).toBe("reception:clue:reception-clue-speed");
  });

  it("requires same-facility affiliation matches for same-room faction skills", () => {
    const state = createDefaultState();
    ownOperators(state, [morgan.id, siege.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const morganBase = findCandidates(trading, state).find((candidate) => candidate.operatorId === morgan.id)!;
    const morganWithSiege = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, siege.id)]
    }).find((candidate) => candidate.operatorId === morgan.id)!;

    expect(morgan.affiliations).toContain("glasgow");
    expect(siege.affiliations).toContain("glasgow");
    expect(morganBase.skillId).toBe(morganGlasgowSkill.id);
    expect(morganBase.efficiency).toBeCloseTo(0.2);
    expect(morganWithSiege.skillId).toBe(morganGlasgowSkill.id);
    expect(morganWithSiege.efficiency).toBeCloseTo(0.75);
  });

  it("applies Sami reception bonuses only when another Sami operator is assigned together", () => {
    const state = createDefaultState();
    ownOperators(state, [typhon.id, valarqvin.id]);
    const reception: FacilitySlot = { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" };
    const facilities = [...state.facilities, reception];
    const typhonBase = findCandidates(reception, state).find((candidate) => candidate.operatorId === typhon.id)!;
    const typhonWithSami = findCandidates(reception, state, 0, {
      facilities,
      assignments: [contextAssignment(reception, valarqvin.id)]
    }).find((candidate) => candidate.operatorId === typhon.id)!;
    const valarqvinBase = findCandidates(reception, state).find((candidate) => candidate.operatorId === valarqvin.id)!;
    const valarqvinWithTyphon = findCandidates(reception, state, 0, {
      facilities,
      assignments: [contextAssignment(reception, typhon.id)]
    }).find((candidate) => candidate.operatorId === valarqvin.id)!;

    expect(typhon.affiliations).toContain("sami");
    expect(valarqvin.affiliations).toContain("sami");
    expect(typhonBase.efficiency).toBeCloseTo(0.1);
    expect(typhonWithSami.efficiency).toBeCloseTo(0.15);
    expect(valarqvinBase.efficiency).toBeCloseTo(0.1);
    expect(valarqvinWithTyphon.efficiency).toBeCloseTo(0.25);
  });

  it("scales Rosa's control recovery by Ursus Student operators in the control center", () => {
    const state = createDefaultState();
    ownOperators(state, [rosa.id, zima.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const rosaBase = findCandidates(control, state).find((candidate) => candidate.operatorId === rosa.id)!;
    const rosaWithStudent = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, zima.id)]
    }).find((candidate) => candidate.operatorId === rosa.id)!;

    expect(rosa.affiliations).toContain("student");
    expect(zima.affiliations).toContain("student");
    expect(rosaBase.efficiency).toBeCloseTo(0.05);
    expect(rosaWithStudent.efficiency).toBeCloseTo(0.1);
  });

  it("adds Lemuen's Exusiai same-trading-post bonus when evaluating candidates", () => {
    const state = createDefaultState();
    ownOperators(state, [lemuen.id, exusiai.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const withoutExusiaiContext = findCandidates(trading, state).find((candidate) => candidate.operatorId === lemuen.id)!;
    const withExusiaiContext = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, exusiai.id)]
    }).find((candidate) => candidate.operatorId === lemuen.id)!;

    expect(withoutExusiaiContext.efficiency).toBeCloseTo(0.2);
    expect(withExusiaiContext.skillId).toBe(lemuenExusiaiSkill.id);
    expect(withExusiaiContext.efficiency).toBeCloseTo(0.45);
  });

  it("uses skillless referenced operators to satisfy named operator conditions", () => {
    const withoutSuzuranState = createDefaultState();
    ownOperators(withoutSuzuranState, [vulpisfoglia.id]);
    const withSuzuranState = createDefaultState();
    ownOperators(withSuzuranState, [vulpisfoglia.id, suzuran.id]);
    const reception: FacilitySlot = { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" };
    const withoutSuzuran = findCandidates(reception, withoutSuzuranState).find((candidate) => candidate.operatorId === vulpisfoglia.id)!;
    const withOwnedSuzuran = findCandidates(reception, withSuzuranState).find((candidate) => candidate.operatorId === vulpisfoglia.id)!;

    expect(suzuran.skills).toHaveLength(0);
    expect(withoutSuzuran.skillId).not.toBe(vulpisfogliaSuzuranSkill.id);
    expect(withOwnedSuzuran.skillId.split("+")).toContain(vulpisfogliaSuzuranSkill.id);
    expect(withOwnedSuzuran.efficiency).toBeGreaterThan(withoutSuzuran.efficiency);
  });

  it("reserves room slots for skillless facility prerequisites", () => {
    const state = createDefaultState();
    const reception: FacilitySlot = { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" };
    state.facilities = [reception];
    ownOperators(state, [vulpisfoglia.id, suzuran.id]);

    const plan = generateAssignmentPlan(state);
    const receptionPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === reception.id)!;
    const suzuranAssignment = receptionPlan.assignments.find((assignment) => assignment.operatorId === suzuran.id)!;

    expect(suzuran.skills).toHaveLength(0);
    expect(receptionPlan.assignments).toHaveLength(2);
    expect(receptionPlan.assignments.some((assignment) => assignment.operatorId === vulpisfoglia.id)).toBe(true);
    expect(suzuranAssignment.skillId).toBe("skillless-prerequisite");
    expect(suzuranAssignment.skilllessPrerequisiteFor).toBe(vulpisfoglia.id);
    expect(plan.warnings).toEqual([]);
  });

  it("scales Muelsyse's power bonus by other Rhine operators assigned in the base", () => {
    const state = createDefaultState();
    ownOperators(state, [muelsyse.id, saria.id]);
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const base = findCandidates(power, state).find((candidate) => candidate.operatorId === muelsyse.id)!;
    const withRhine = findCandidates(power, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(factory, saria.id)]
    }).find((candidate) => candidate.operatorId === muelsyse.id)!;

    expect(muelsyse.affiliations).toContain("rhine");
    expect(saria.affiliations).toContain("rhine");
    expect(base.efficiency).toBeCloseTo(0.1);
    expect(withRhine.efficiency).toBeCloseTo(0.13);
  });

  it("scales Eunectes factory productivity by power plant count", () => {
    const state = createDefaultState();
    ownOperators(state, [eunectes.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === eunectes.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.3);
  });

  it("counts Eunectes's virtual power plants for facility-count scaling", () => {
    const state = createDefaultState();
    ownOperators(state, [eunectes.id, lancet.id, weedy.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const lancetAssignment = contextAssignment(power, lancet.id);
    const eunectesControlAssignment = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [lancetAssignment]
    }).find((assignment) => assignment.operatorId === eunectes.id)!;
    const base = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [lancetAssignment]
    }).find((assignment) => assignment.operatorId === weedy.id)!;
    const withVirtualPowerPlants = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [lancetAssignment, eunectesControlAssignment]
    }).find((assignment) => assignment.operatorId === weedy.id)!;

    expect(eunectesControlAssignment.efficiency).toBe(0);
    expect(eunectesControlAssignment.score).toBeCloseTo(10.5);
    expect(eunectesControlAssignment.remoteFacilityCountBonuses).toContainEqual({ facility: "power", amount: 2 });
    expect(withVirtualPowerPlants.efficiency - base.efficiency).toBeCloseTo(0.3);
  });

  it("does not score Eunectes's virtual power plants from her own factory skill", () => {
    const state = createDefaultState();
    ownOperators(state, [eunectes.id, lancet.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    const candidate = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(power, lancet.id)]
    }).find((assignment) => assignment.operatorId === eunectes.id)!;

    expect(candidate.efficiency).toBe(0);
    expect(candidate.score).toBe(0);
    expect(candidate.remoteFacilityCountBonuses).toContainEqual({ facility: "power", amount: 2 });
  });

  it("keeps Snegurochka suppressing scaling tied to retained factory occupants", () => {
    const state = createDefaultState();
    ownOperators(state, [snegurochka.id, texas.id, lappland.id]);
    state.roster[snegurochka.id].elite = 1;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(factory, texas.id), contextAssignment(factory, lappland.id)]
    }).find((assignment) => assignment.operatorId === snegurochka.id)!;

    expect(candidate.suppressesOtherFactoryEfficiency).toBe(true);
    expect(candidate.efficiency).toBeCloseTo(0.1);
  });

  it("uses max facility level for reception-level scaling skills", () => {
    const state = createDefaultState();
    ownOperators(state, [vigil.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === vigil.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.4);
  });

  it("counts assigned operation platforms for factory and control conditions", () => {
    const state = createDefaultState();
    ownOperators(state, [alanna.id, lancet.id, justiceKnight.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const power1 = state.facilities.find((facility) => facility.id === "power-1")!;
    const power2 = state.facilities.find((facility) => facility.id === "power-2")!;
    const alannaBase = findCandidates(factory, state).find((assignment) => assignment.operatorId === alanna.id)!;
    const alannaWithPlatforms = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(power1, lancet.id), contextAssignment(power2, justiceKnight.id)]
    }).find((assignment) => assignment.operatorId === alanna.id)!;

    expect(lancet.affiliations).toContain("platform");
    expect(justiceKnight.affiliations).toContain("platform");
    expect(alannaBase.efficiency).toBeCloseTo(0);
    expect(alannaWithPlatforms.efficiency).toBeCloseTo(0.2);
  });

  it("uses modeled drone cap assumptions for Greyy the Lightningbearer's power skill", () => {
    const state = createDefaultState();
    ownOperators(state, [greyyAlter.id]);
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    const candidate = findCandidates(power, state).find((assignment) => assignment.operatorId === greyyAlter.id)!;
    const dawnlight = greyyAlter.skills.find((skill) => skill.id === "power_count[000]")!.effects[0];

    expect(candidate.efficiency).toBeCloseTo(0.2);
    expect(
      conditionsSatisfied(dawnlight.conditions, greyyAlter, power, {
        facilities: state.facilities,
        assignments: [],
        roster: state.roster
      })
    ).toBe(true);
  });

  it("averages time-ramping skills across the configured rotation window", () => {
    const state = createDefaultState();
    ownOperators(state, [fang.id]);
    state.roster[fang.id].elite = 0;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const twelveHourCandidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === fang.id)!;

    const eightHourCandidate = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [],
      roster: state.roster,
      shiftHours: 8
    }).find((assignment) => assignment.operatorId === fang.id)!;

    expect(twelveHourCandidate.efficiency).toBeCloseTo(0.2375);
    expect(eightHourCandidate.efficiency).toBeCloseTo(0.23125);
  });

  it("models Totter's productivity from Morale spent during the 12-hour shift", () => {
    const state = createDefaultState();
    const factory = { ...state.facilities.find((facility) => facility.id === "factory-1")!, slotCount: 1 };
    state.facilities = [factory];
    ownOperators(state, [totter.id]);
    state.roster[totter.id].elite = 1;

    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === totter.id)!;
    const planAssignment = generateAssignmentPlan(state).facilityPlans[0].assignments.find(
      (assignment) => assignment.operatorId === totter.id
    )!;

    expect(candidate.efficiency).toBeCloseTo(0.25);
    expect(candidate.storageLimit).toBeUndefined();
    expect(planAssignment.efficiency).toBeCloseTo(0.25);
  });

  it("uses max total dormitory level for dorm-level scaling skills", () => {
    const state = createDefaultState();
    ownOperators(state, [archetto.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === archetto.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.4);
  });

  it("folds max construction robot count into Minimalist's production skill", () => {
    const state = createDefaultState();
    ownOperators(state, [minimalist.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === minimalist.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.4);
  });

  it("applies Lee's control-center clue speed bonus to reception assignments", () => {
    const state = createDefaultState();
    ownOperators(state, [lee.id, may.id]);
    state.facilities = [
      ...state.facilities,
      { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" }
    ];
    const plan = generateAssignmentPlan(state);
    const receptionPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.type === "reception")!;
    const receptionAssignment = receptionPlan.assignments.find((assignment) => assignment.operatorId === may.id)!;

    expect(plan.facilityPlans.some((facilityPlan) => facilityPlan.assignments.some((assignment) => assignment.operatorId === lee.id))).toBe(true);
    expect(receptionAssignment.efficiency).toBeCloseTo(0.2);
    expect(receptionPlan.expectedEfficiency).toBeCloseTo(0.45);
  });

  it("does not score control-center global boosts when no target room exists", () => {
    const state = createDefaultState();
    ownOperators(state, [lee.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;

    const leeCandidate = findCandidates(control, state).find((assignment) => assignment.operatorId === lee.id);

    expect(state.facilities.some((facility) => facility.type === "reception")).toBe(false);
    expect(leeCandidate).toBeUndefined();
  });

  it("does not let control-center production boosts shorten facility recovery", () => {
    const state = createDefaultState();
    for (const entry of Object.values(state.roster)) entry.owned = false;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    state.facilities = [control, trading];
    ownOperators(state, [amiya.id, defaultOwnedTradingOperator.id]);

    const plan = generateAssignmentPlan(state);
    const tradingPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === trading.id)!;
    const tradingAssignment = tradingPlan.assignments.find((assignment) => assignment.operatorId === defaultOwnedTradingOperator.id)!;

    expect(plan.facilityPlans.some((facilityPlan) => facilityPlan.assignments.some((assignment) => assignment.operatorId === amiya.id))).toBe(true);
    expect(tradingPlan.expectedEfficiency).toBeGreaterThan(tradingAssignment.efficiency);
    expect(tradingAssignment.recoveryHours).toBeCloseTo(
      (tradingAssignment.moraleConsumptionPerHour! * 12) / tradingAssignment.dormitoryRecoveryPerHour!
    );
  });

  it("derives working and recovery time from control staffing and morale skills", () => {
    const state = createDefaultState();
    for (const entry of Object.values(state.roster)) entry.owned = false;
    ownOperators(state, [amiya.id, gummy.id]);
    const control = { ...state.facilities.find((facility) => facility.id === "control-1")!, slotCount: 1 };
    const trading = { ...state.facilities.find((facility) => facility.id === "trading-1")!, slotCount: 1 };
    state.facilities = [control, trading];

    const plan = generateAssignmentPlan(state);
    const gummyAssignment = plan.facilityPlans
      .find((facilityPlan) => facilityPlan.facility.id === trading.id)!
      .assignments.find((assignment) => assignment.operatorId === gummy.id)!;

    expect(gummyAssignment.moraleConsumptionPerHour).toBeCloseTo(0.7);
    expect(gummyAssignment.fatigueHours).toBeCloseTo(24 / 0.7);
    expect(gummyAssignment.dormitoryRecoveryPerHour).toBeGreaterThanOrEqual(4);
    expect(gummyAssignment.recoveryHours).toBeCloseTo(8.4 / gummyAssignment.dormitoryRecoveryPerHour!);
  });

  it("scales Terra Research Commission from catnip generated in the control center", () => {
    const state = createDefaultState();
    ownOperators(state, [terraResearchCommission.id, yatoAlter.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const base = findCandidates(trading, state).find((assignment) => assignment.operatorId === terraResearchCommission.id)!;
    const withCatnip = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, yatoAlter.id)]
    }).find((assignment) => assignment.operatorId === terraResearchCommission.id)!;

    expect(withCatnip.efficiency - base.efficiency).toBeCloseTo(0.24);
  });

  it("scales Iana's reception speed from Rainbow intel reserve", () => {
    const state = createDefaultState();
    ownOperators(state, [iana.id, ash.id, blitz.id]);
    const reception: FacilitySlot = { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" };
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const facilities = [...state.facilities, reception];
    const base = findCandidates(reception, state).find((assignment) => assignment.operatorId === iana.id)!;
    const withIntelReserve = findCandidates(reception, state, 0, {
      facilities,
      assignments: [contextAssignment(control, ash.id), contextAssignment(control, blitz.id)]
    }).find((assignment) => assignment.operatorId === iana.id)!;

    expect(withIntelReserve.efficiency - base.efficiency).toBeCloseTo(0.1);
  });

  it("includes a candidate's own generated resources while scoring resource-scaling skills", () => {
    const state = createDefaultState();
    ownOperators(state, [mrNothing.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === mrNothing.id)!;

    expect(candidate.skillId).toBe("trade_ord_spd_bd_n2[000]");
    expect(candidate.efficiency).toBeCloseTo(0.2);
  });

  it("does not score high-value order probability as generic trading efficiency", () => {
    const state = createDefaultState();
    ownOperators(state, [bibeak.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(findCandidates(trading, state).some((assignment) => assignment.operatorId === bibeak.id)).toBe(false);
  });

  it("does not score training-room or office-only control effects as control productivity", () => {
    const state = createDefaultState();
    ownOperators(state, [ascalon.id, saileach.id]);
    state.roster[ascalon.id].elite = 0;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const candidates = findCandidates(control, state);

    expect(candidates.some((assignment) => assignment.operatorId === ascalon.id && assignment.skillId === "control_train_spd[010]")).toBe(false);
    expect(candidates.some((assignment) => assignment.operatorId === saileach.id && assignment.skillId === "control_hire_spd[000]")).toBe(false);
  });

  it("retains skillless operators referenced by conditional bonus requirements", () => {
    const operatorIds = new Set(operators.map((operator) => operator.id));
    const conditionalOperatorIds = new Set(
      operators.flatMap((operator) =>
        operator.skills.flatMap((skill) =>
          skill.effects.flatMap((effect) =>
            (effect.conditionalBonuses ?? []).flatMap((bonus) =>
              (bonus.conditions ?? []).flatMap((condition) => ("operatorIds" in condition ? condition.operatorIds : []))
            )
          )
        )
      )
    );

    expect([...conditionalOperatorIds].filter((operatorId) => !operatorIds.has(operatorId))).toEqual([]);
    expect(operators.find((operator) => operator.id === "char_113_cqbw")?.name.en).toBe("W");
    expect(operators.find((operator) => operator.id === "char_4145_ulpia")?.name.en).toBe("Ulpianus");
  });

  it("keeps checked-in base skill overrides aligned with generated operator data", () => {
    const alannaProduct = baseSkillOverrides.char_4178_alanna.skills["manu_token_prod_spd[010]"].effects[0].patch.product;
    const texasEfficiency = baseSkillOverrides.char_102_texas.skills["trade_ord_limit&cost_P[010]"].effects[0].patch.efficiency;
    const aromaOverride = baseSkillOverrides.char_446_aroma.skills["manu_prod_spd_addition[100]"] as { addEffects?: unknown[] };
    const aromaAddEffects = aromaOverride.addEffects;
    const flametailOverride = baseSkillOverrides.char_420_flamtl.skills["control_mp_psk[000]"];
    const pozemkaOverrides = baseSkillOverrides.char_4055_bgsnow.skills;
    const kiraraOverrides = baseSkillOverrides.char_478_kirara.skills;
    const tuyeOverrides = baseSkillOverrides.char_402_tuye.skills;
    const uOfficialOverrides = baseSkillOverrides.char_4091_ulika.skills;

    expect(alannaProduct).toBe("gold");
    expect(texasEfficiency).toBe(0);
    expect(aromaAddEffects).toBeUndefined();
    expect(flametailOverride.effects[0].patch.product).toBe("battleRecord");
    expect(flametailOverride.addEffects).toEqual(
      expect.arrayContaining([expect.objectContaining({ facility: "control", product: "gold", efficiency: -0.1 })])
    );
    expect(pozemkaOverrides["trade_ord_spd&gold[100]"].effects[0].patch.product).toBe("lmd");
    expect(pozemkaOverrides["trade_ord_line_durin[010]"].effects[0].patch.product).toBe("lmd");
    expect(kiraraOverrides["trade_ord_line_gold[000]"].effects[0].patch.product).toBe("lmd");
    expect(kiraraOverrides["trade_ord_line_gold[010]"].effects[0].patch.product).toBe("lmd");
    expect(tuyeOverrides["trade_ord_spd&gold[000]"].effects[0].patch.product).toBe("lmd");
    expect(tuyeOverrides["trade_ord_spd&gold[010]"].effects[0].patch.product).toBe("lmd");
    expect(uOfficialOverrides["trade_ord_spd&wt[000]"].effects[0].patch.product).toBe("lmd");
  });

  it("registers handlers for complex remote control efficiency skills", () => {
    const registeredKeys = new Set(registeredComplexBaseSkillHandlerKeys("remoteFacilityEfficiencyBonuses"));
    const remoteControlKeys = operators.flatMap((operator) =>
      operator.skills.flatMap((skill) =>
        skill.effects
          .filter(
            (effect) =>
              effect.facility === "control" &&
              !effect.globalEffect &&
              (effect.scaling?.type === "facilityGroupAffiliation" ||
                (effect.conditions ?? []).some(
                  (condition) =>
                    condition.type === "facilityAffiliation" &&
                    condition.facility !== undefined &&
                    condition.facility !== effect.facility
                ))
          )
          .map(() => `${operator.id}:${skill.id}`)
      )
    );

    expect([...new Set(remoteControlKeys)].sort()).toEqual([...registeredKeys].sort());
  });

  it("registers handlers for suppressing same-factory scaling skills", () => {
    const registeredKeys = new Set(registeredComplexBaseSkillHandlerKeys("scalingMultiplier"));
    const suppressingSameFacilityScalingKeys = operators.flatMap((operator) =>
      operator.skills.flatMap((skill) =>
        skill.effects
          .filter(
            (effect) =>
              effect.suppressesOtherFactoryEfficiency &&
              effect.scaling?.scope === "sameFacility" &&
              Boolean(effect.scaling.includeSelf)
          )
          .map(() => `${operator.id}:${skill.id}`)
      )
    );

    expect([...new Set(suppressingSameFacilityScalingKeys)].sort()).toEqual([...registeredKeys].sort());
  });

  it("keeps active trading effects compatible with LMD trading rooms", () => {
    const mismatches = operators.flatMap((operator) =>
      operator.skills.flatMap((skill) =>
        skill.effects
          .filter((effect) => effect.facility === "trading" && effect.product && effect.product !== "lmd" && !effect.ignoredForOptimization)
          .map((effect) => ({ operatorId: operator.id, skillId: skill.id, product: effect.product }))
      )
    );

    expect(mismatches).toEqual([]);
  });

  it("matches Pozemka's gold-line trading skills to LMD trading rooms", () => {
    const state = createDefaultState();
    ownOperators(state, [pozemka.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === pozemka.id)!;
    const salesPromotionEffect = pozemka.skills.find((skill) => skill.id === "trade_ord_spd&gold[100]")!.effects[0];
    const durinLineEffect = pozemka.skills.find((skill) => skill.id === "trade_ord_line_durin[010]")!.effects[0];

    expect(salesPromotionEffect.product).toBe("lmd");
    expect(durinLineEffect.product).toBe("lmd");
    expect(candidate.skillId).toBe("trade_ord_spd&gold[100]");
    expect(candidate.efficiency).toBeCloseTo(0.1);
  });

  it("keeps Kirara's fixed trading bonus while excluding unsupported line scaling", () => {
    const state = createDefaultState();
    ownOperators(state, [kirara.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === kirara.id)!;
    const firstEffect = kirara.skills.find((skill) => skill.id === "trade_ord_line_gold[000]")!.effects[0];
    const secondEffect = kirara.skills.find((skill) => skill.id === "trade_ord_line_gold[010]")!.effects[0];

    expect(firstEffect.product).toBe("lmd");
    expect(secondEffect.product).toBe("lmd");
    expect(firstEffect.ignoredForOptimization).toBeUndefined();
    expect(secondEffect.ignoredForOptimization).toBeUndefined();
    expect(candidate.efficiency).toBeCloseTo(0.05);
  });

  it("keeps morale-cost factory capacity skills product-neutral", () => {
    const state = createDefaultState();
    ownOperators(state, [bubble.id, vermeil.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const bubbleStorageSkill = bubble.skills.find((skill) => skill.id === "manu_prod_limit&cost[010]")!;
    const bubbleStorageEffect = bubbleStorageSkill.effects.find((effect) => effect.storageLimit === 10)!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === bubble.id)!;
    const withVermeil = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(factory, vermeil.id, { storageLimit: 8 })]
    }).find((assignment) => assignment.operatorId === bubble.id)!;

    expect(bubbleStorageEffect.product).toBeUndefined();
    expect(candidate.skillId.split("+")).toContain("manu_prod_spd_variable3[000]");
    expect(candidate.storageLimit).toBe(10);
    expect(candidate.efficiency).toBeCloseTo(0.1);
    expect(withVermeil.skillId.split("+")).toContain("manu_prod_spd_variable3[000]");
    expect(withVermeil.storageLimit).toBe(10);
    expect(withVermeil.efficiency).toBeCloseTo(0.18);
  });

  it("keeps morale-only factory skills out of production candidates", () => {
    const waaiFuState = createDefaultState();
    ownOperators(waaiFuState, [waaiFu.id]);
    waaiFuState.roster[waaiFu.id].elite = 0;
    const waaiFuFactory = waaiFuState.facilities.find((facility) => facility.id === "factory-1")!;
    const waaiFuMoraleEffect = waaiFu.skills.find((skill) => skill.id === "manu_cost_all[000]")!.effects[0];

    const shuState = createDefaultState();
    ownOperators(shuState, [shu.id]);
    shuState.roster[shu.id].elite = 0;
    const shuFactory = shuState.facilities.find((facility) => facility.id === "factory-1")!;
    const shuMoraleEffect = shu.skills.find((skill) => skill.id === "manu_cost[000]")!.effects[0];

    expect(waaiFuMoraleEffect.product).toBe("morale");
    expect(shuMoraleEffect.product).toBe("morale");
    expect(findCandidates(waaiFuFactory, waaiFuState).some((assignment) => assignment.skillId === "manu_cost_all[000]")).toBe(false);
    expect(findCandidates(shuFactory, shuState).some((assignment) => assignment.skillId === "manu_cost[000]")).toBe(false);
  });

  it("scales Vermeil from same-factory storage limit increases", () => {
    const state = createDefaultState();
    ownOperators(state, [vermeil.id, bubble.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const base = findCandidates(factory, state).find((assignment) => assignment.operatorId === vermeil.id)!;
    const withStoragePartner = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(factory, bubble.id, { storageLimit: 10 })]
    }).find((assignment) => assignment.operatorId === vermeil.id)!;

    expect(base.storageLimit).toBe(8);
    expect(base.efficiency).toBeCloseTo(0.16);
    expect(withStoragePartner.efficiency).toBeCloseTo(0.36);
  });

  it("ignores negative storage limit modifiers for Vermeil scaling", () => {
    const state = createDefaultState();
    ownOperators(state, [vermeil.id, bubble.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const base = findCandidates(factory, state).find((assignment) => assignment.operatorId === vermeil.id)!;
    const withNegativeStorage = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(factory, bubble.id, { storageLimit: -12 })]
    }).find((assignment) => assignment.operatorId === vermeil.id)!;

    expect(withNegativeStorage.efficiency).toBeCloseTo(base.efficiency);
  });

  it("scales Degenbrecher from same-trading-post order limit increases", () => {
    const state = createDefaultState();
    ownOperators(state, [degenbrecher.id, silverashAlter.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const base = findCandidates(trading, state).find((assignment) => assignment.operatorId === degenbrecher.id)!;
    const withOrderLimit = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, silverashAlter.id, { orderLimit: 10 })]
    }).find((assignment) => assignment.operatorId === degenbrecher.id)!;

    expect(base.efficiency).toBeCloseTo(0.25);
    expect(withOrderLimit.efficiency).toBeCloseTo(0.75);
  });

  it("routes Gnosis's remote order-limit bonus to Karlan trading post partners", () => {
    const state = createDefaultState();
    const karlanTradingPartners = operators
      .filter(
        (operator) =>
          operator.id !== degenbrecher.id &&
          operator.id !== gnosis.id &&
          operator.affiliations?.includes("karlan") &&
          operator.skills.some((skill) =>
            skill.effects.some((effect) => effect.facility === "trading" && (!effect.product || effect.product === "lmd"))
          )
      )
      .slice(0, 2);
    ownOperators(state, [degenbrecher.id, gnosis.id, ...karlanTradingPartners.map((operator) => operator.id)]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const karlanTradingAssignments = [
      contextAssignment(trading, karlanTradingPartners[0].id, { orderLimit: 4 }),
      contextAssignment(trading, karlanTradingPartners[1].id)
    ];
    const gnosisAssignment = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: karlanTradingAssignments
    }).find((assignment) => assignment.operatorId === gnosis.id)!;
    const withoutGnosis = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: karlanTradingAssignments
    }).find((assignment) => assignment.operatorId === degenbrecher.id)!;
    const withGnosis = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [...karlanTradingAssignments, gnosisAssignment]
    }).find((assignment) => assignment.operatorId === degenbrecher.id)!;

    expect(karlanTradingPartners).toHaveLength(2);
    expect(karlanTradingPartners.every((operator) => operator.affiliations?.includes("karlan"))).toBe(true);
    expect(gnosisAssignment.remoteFacilityStatBonuses).toContainEqual(
      expect.objectContaining({ key: "orderLimit", facility: "trading", amount: 6 })
    );
    expect(gnosisAssignment.remoteFacilityEfficiencyBonuses).toContainEqual({
      facility: "trading",
      amount: -0.15,
      product: "lmd",
      affiliations: ["karlan"],
      min: 1
    });
    expect(gnosisAssignment.efficiency).toBe(0);
    expect(gnosisAssignment.score).toBeGreaterThan(0);
    expect(withGnosis.efficiency - withoutGnosis.efficiency).toBeCloseTo(0.75);
  });

  it("routes Wis'adel's named remote order-limit bonus to Hoederer", () => {
    const state = createDefaultState();
    ownOperators(state, [degenbrecher.id, hedley.id, wisadel.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const hedleyTradingAssignment = contextAssignment(trading, hedley.id, { orderLimit: 8 });
    const wisadelAssignment = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [hedleyTradingAssignment]
    }).find((assignment) => assignment.operatorId === wisadel.id)!;
    const withoutWisadel = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [hedleyTradingAssignment]
    }).find((assignment) => assignment.operatorId === degenbrecher.id)!;
    const withWisadel = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [hedleyTradingAssignment, wisadelAssignment]
    }).find((assignment) => assignment.operatorId === degenbrecher.id)!;

    expect(wisadelAssignment.remoteFacilityStatBonuses).toContainEqual(
      expect.objectContaining({ key: "orderLimit", facility: "trading", amount: 2, operatorIds: [hedley.id] })
    );
    expect(wisadelAssignment.remoteFacilityStatBonuses).not.toContainEqual(
      expect.objectContaining({ key: "orderLimit", facility: "trading", amount: 1, operatorIds: [hedley.id] })
    );
    expect(withWisadel.efficiency - withoutWisadel.efficiency).toBeCloseTo(0.25);
  });

  it("ignores negative order limit modifiers for Degenbrecher scaling", () => {
    const state = createDefaultState();
    ownOperators(state, [degenbrecher.id, silverashAlter.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const base = findCandidates(trading, state).find((assignment) => assignment.operatorId === degenbrecher.id)!;
    const withNegativeOrderLimit = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, silverashAlter.id, { orderLimit: -6 })]
    }).find((assignment) => assignment.operatorId === degenbrecher.id)!;

    expect(withNegativeOrderLimit.efficiency).toBeCloseTo(base.efficiency);
  });

  it("nets simultaneous positive and negative facility limit modifiers", () => {
    const state = createDefaultState();
    ownOperators(state, [asbestos.id, wulfenite.id]);
    state.roster[asbestos.id].elite = 2;
    state.roster[wulfenite.id].elite = 2;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const asbestosCandidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === asbestos.id)!;
    const wulfeniteCandidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === wulfenite.id)!;

    expect(asbestosCandidate.storageLimit).toBe(4);
    expect(wulfeniteCandidate.storageLimit).toBe(8);
  });

  it("keeps strongest same-sign facility limit upgrade instead of summing variants", () => {
    const state = createDefaultState();
    ownOperators(state, [vulcan.id, degenbrecher.id]);
    state.roster[vulcan.id].elite = 2;
    state.roster[degenbrecher.id].elite = 2;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const vulcanCandidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === vulcan.id)!;
    const degenbrecherCandidate = findCandidates(trading, state).find(
      (assignment) => assignment.operatorId === degenbrecher.id
    )!;

    expect(vulcanCandidate.storageLimit).toBe(19);
    expect(degenbrecherCandidate.orderLimit).toBe(-6);
  });

  it("scales Sakiko Togawa's gold factory control effect from passion", () => {
    const baseState = createDefaultState();
    ownOperators(baseState, [obliviator.id, defaultOwnedGoldFactoryOperator.id]);
    baseState.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    const basePlan = generateAssignmentPlan(baseState);
    const baseGoldEfficiency = basePlan.facilityPlans
      .filter((facilityPlan) => facilityPlan.facility.product === "gold")
      .reduce((sum, facilityPlan) => sum + facilityPlan.expectedEfficiency, 0);

    const passionState = createDefaultState();
    ownOperators(passionState, [obliviator.id, mortis.id, defaultOwnedGoldFactoryOperator.id]);
    passionState.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    const passionPlan = generateAssignmentPlan(passionState);
    const passionGoldEfficiency = passionPlan.facilityPlans
      .filter((facilityPlan) => facilityPlan.facility.product === "gold")
      .reduce((sum, facilityPlan) => sum + facilityPlan.expectedEfficiency, 0);

    const goldFacilityCount = passionPlan.facilityPlans.filter((facilityPlan) => facilityPlan.facility.product === "gold").length;
    expect(passionGoldEfficiency - baseGoldEfficiency).toBeCloseTo(0.01 * goldFacilityCount);
  });

  it("applies Mortis's trading boost globally without counting it as control efficiency", () => {
    const baseState = createDefaultState();
    ownOperators(baseState, [defaultOwnedTradingOperator.id]);
    const basePlan = generateAssignmentPlan(baseState);
    const baseTradingPlan = basePlan.facilityPlans.find((facilityPlan) =>
      facilityPlan.assignments.some((assignment) => assignment.operatorId === defaultOwnedTradingOperator.id)
    )!;

    const boostState = createDefaultState();
    ownOperators(boostState, [defaultOwnedTradingOperator.id, mortis.id]);
    boostState.roster[mortis.id].elite = 0;
    const boostPlan = generateAssignmentPlan(boostState);
    const boostTradingPlan = boostPlan.facilityPlans.find((facilityPlan) =>
      facilityPlan.assignments.some((assignment) => assignment.operatorId === defaultOwnedTradingOperator.id)
    )!;
    const controlPlan = boostPlan.facilityPlans.find((facilityPlan) => facilityPlan.facility.type === "control")!;
    const mortisAssignment = controlPlan.assignments.find((assignment) => assignment.operatorId === mortis.id)!;

    expect(mortisAssignment.efficiency).toBe(0);
    expect(boostTradingPlan.expectedEfficiency - baseTradingPlan.expectedEfficiency).toBeCloseTo(0.01);
  });

  it("scores all-room global boosts for every matching facility", () => {
    const state = createDefaultState();
    ownOperators(state, [mortis.id]);
    state.roster[mortis.id].elite = 0;
    const control = state.facilities.find((facility) => facility.type === "control")!;
    const candidate = findCandidates(control, state).find((assignment) => assignment.operatorId === mortis.id)!;
    const matchingTradingPostCount = state.facilities.filter((facility) => facility.type === "trading" && facility.product === "lmd").length;

    expect(candidate.efficiency).toBe(0);
    expect(candidate.score).toBeCloseTo(0.01 * state.preference.lmd * 100 * matchingTradingPostCount);
  });

  it("routes cross-room control productivity bonuses to the target factory", () => {
    const baseState = createDefaultState();
    ownOperators(baseState, [blacksteelFactoryOperator.id]);
    baseState.facilities = [
      baseState.facilities.find((facility) => facility.id === "factory-1")!,
      baseState.facilities.find((facility) => facility.id === "control-1")!
    ];
    const basePlan = generateAssignmentPlan(baseState);
    const baseFactoryPlan = basePlan.facilityPlans.find((facilityPlan) => facilityPlan.facility.type === "factory")!;

    const boostState = createDefaultState();
    ownOperators(boostState, [blacksteelFactoryOperator.id, jessicaAlter.id]);
    boostState.facilities = [
      boostState.facilities.find((facility) => facility.id === "factory-1")!,
      boostState.facilities.find((facility) => facility.id === "control-1")!
    ];
    const boostPlan = generateAssignmentPlan(boostState);
    const boostFactoryPlan = boostPlan.facilityPlans.find((facilityPlan) => facilityPlan.facility.type === "factory")!;
    const controlPlan = boostPlan.facilityPlans.find((facilityPlan) => facilityPlan.facility.type === "control")!;
    const jessicaAssignment = controlPlan.assignments.find((assignment) => assignment.operatorId === jessicaAlter.id)!;

    expect(blacksteelFactoryOperator.affiliations).toContain("blacksteel");
    expect(jessicaAssignment.efficiency).toBe(0);
    expect(boostFactoryPlan.expectedEfficiency - baseFactoryPlan.expectedEfficiency).toBeCloseTo(0.05);
  });

  it("models Flametail's Pinus factory product modifiers with product-specific signs", () => {
    const state = createDefaultState();
    ownOperators(state, [flametail.id, pinusFactoryOperator.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const factory = { ...state.facilities.find((facility) => facility.id === "factory-1")!, product: "battleRecord" as const };
    const candidate = findCandidates(control, state, 0, {
      facilities: [control, factory],
      assignments: [contextAssignment(factory, pinusFactoryOperator.id)]
    }).find((assignment) => assignment.operatorId === flametail.id)!;

    expect(pinusFactoryOperator.affiliations).toContain("pinus");
    expect(candidate.remoteFacilityEfficiencyBonuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ facility: "factory", product: "battleRecord", amount: 0.1, affiliations: ["pinus"] }),
        expect.objectContaining({ facility: "factory", product: "gold", amount: -0.1, affiliations: ["pinus"] })
      ])
    );
    expect(candidate.score).toBeGreaterThan(0);
  });

  it("scores Flametail's mixed-sign remote factory modifiers as a net effect", () => {
    const state = createDefaultState();
    ownOperators(state, [flametail.id, pinusFactoryOperator.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const factory = { ...state.facilities.find((facility) => facility.id === "factory-1")!, product: "gold" as const };
    const candidate = findCandidates(control, state, 0, {
      facilities: [control, factory],
      assignments: [contextAssignment(factory, pinusFactoryOperator.id)]
    }).find((assignment) => assignment.operatorId === flametail.id)!;

    expect(candidate.remoteFacilityEfficiencyBonuses).toEqual(
      expect.arrayContaining([expect.objectContaining({ facility: "factory", product: "gold", amount: -0.1, affiliations: ["pinus"] })])
    );
    expect(candidate.score).toBeLessThan(0);
  });

  it("deduplicates non-stacking global control boosts in the control center", () => {
    const state = createDefaultState();
    const duplicateTradingBoostOperators = operators
      .filter((operator) =>
        operator.skills.some((skill) =>
          skill.effects.some((effect) => effect.facility === "control" && effect.globalEffect?.stackKey === "all-trading-speed")
        )
      )
      .slice(0, 3);
    ownOperators(state, duplicateTradingBoostOperators.map((operator) => operator.id));
    const plan = generateAssignmentPlan(state);
    const controlPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.type === "control")!;

    expect(duplicateTradingBoostOperators.length).toBeGreaterThan(1);
    expect(controlPlan.assignments.filter((assignment) => assignment.globalStackKey?.endsWith(":all-trading-speed")).length).toBe(1);
  });

  it("scores global control boosts without generic elite bonus", () => {
    const state = createDefaultState();
    ownOperators(state, [amiya.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const candidate = findCandidates(control, state).find((assignment) => assignment.operatorId === amiya.id)!;

    expect(candidate.skillId).toBe("control_tra_spd[000]");
    expect(candidate.efficiency).toBe(0);
    expect(candidate.score).toBeCloseTo(4.2);
  });

  it("scores product-neutral global factory boosts from target factory products", () => {
    const state = createDefaultState();
    ownOperators(state, [kaltsit.id]);
    state.preference = { gold: 1, battleRecord: 3, lmd: 10 };
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const candidate = findCandidates(control, state).find((assignment) => assignment.operatorId === kaltsit.id)!;
    const expectedScore = state.facilities
      .filter((facility) => facility.type === "factory")
      .reduce((sum, facility) => sum + 0.02 * productWeightForTest(facility.product, state.preference) * 100, 0);
    const lmdFallbackScore = state.facilities.filter((facility) => facility.type === "factory").length * 0.02 * state.preference.lmd * 100;

    expect(candidate.globalStackKey).toBe("factory:*:all-factory-speed");
    expect(candidate.score).toBeCloseTo(expectedScore);
    expect(candidate.score).not.toBeCloseTo(lmdFallbackScore);
  });

  it("does not count Snegurochka's storage-only first skill as production", () => {
    const state = createDefaultState();
    ownOperators(state, [snegurochka.id]);
    state.roster[snegurochka.id].elite = 0;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === snegurochka.id)!;

    expect(candidate.suppressesOtherFactoryEfficiency).toBe(true);
    expect(candidate.efficiency).toBe(0);
  });

  it("keeps only one suppressing factory operator in a single factory plan", () => {
    const state = createDefaultState();
    ownOperators(state, [weedy.id, eunectes.id, windflit.id]);
    const plan = generateAssignmentPlan(state);

    expect(
      plan.facilityPlans
        .filter((facilityPlan) => facilityPlan.facility.type === "factory")
        .every((facilityPlan) => facilityPlan.assignments.filter((assignment) => assignment.suppressesOtherFactoryEfficiency).length <= 1)
    ).toBe(true);
  });

  it("keeps the normal factory group when it beats a suppressing operator alone", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory, ...state.facilities.filter((facility) => facility.type === "power")];
    const normalFactoryOperators = operators
      .filter(
        (operator) =>
          operator.id !== windflit.id &&
          operator.skills.some((skill) =>
            skill.effects.some(
              (effect) =>
                skill.unlockPhase <= 2 &&
                effect.facility === "factory" &&
                (!effect.product || effect.product === factory.product) &&
                !effect.conditions?.length &&
                !effect.ignoredForOptimization &&
                !effect.suppressesOtherFactoryEfficiency &&
                effect.efficiency >= 0.2
            )
          )
      )
      .slice(0, factory.slotCount);
    ownOperators(state, [windflit.id, ...normalFactoryOperators.map((operator) => operator.id)]);

    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === factory.id)!;

    expect(normalFactoryOperators).toHaveLength(factory.slotCount);
    expect(factoryPlan.assignments).toHaveLength(factory.slotCount);
    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === windflit.id)).toBe(false);
  });

  it("models Bena and Vulcan capacity skills as negative factory productivity", () => {
    const state = createDefaultState();
    ownOperators(state, [bena.id, vulcan.id]);
    state.roster[bena.id].elite = 0;
    state.roster[vulcan.id].elite = 0;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const benaCandidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === bena.id)!;
    const vulcanCandidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === vulcan.id)!;

    expect(benaCandidate.efficiency).toBeCloseTo(-0.2);
    expect(benaCandidate.storageLimit).toBe(17);
    expect(vulcanCandidate.efficiency).toBeCloseTo(-0.05);
    expect(vulcanCandidate.storageLimit).toBe(16);
  });

  it("does not fill factory slots with standalone negative productivity candidates", () => {
    const state = createDefaultState();
    ownOperators(state, [bena.id, vulcan.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory];
    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === factory.id)!;

    expect(factoryPlan.assignments).toEqual([]);
    expect(factoryPlan.expectedEfficiency).toBe(0);
  });

  it("does not add negative capacity partners unless their limit synergy is net positive", () => {
    const state = createDefaultState();
    ownOperators(state, [bubble.id, bena.id]);
    state.roster[bena.id].elite = 0;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory];
    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === factory.id)!;

    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === bubble.id)).toBe(true);
    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === bena.id)).toBe(false);
  });

  it("can replace a normal factory worker with a positive capacity partner when the room gains output", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory];
    const normalFactoryOperators = operators
      .filter((operator) =>
        operator.skills.some((skill) =>
          skill.effects.some(
            (effect) =>
              skill.unlockPhase <= 2 &&
              operator.id !== vermeil.id &&
              operator.id !== bubble.id &&
              effect.facility === "factory" &&
              (!effect.product || effect.product === factory.product) &&
              !effect.conditions?.length &&
              !effect.ignoredForOptimization &&
              !effect.suppressesOtherFactoryEfficiency &&
              effect.efficiency === 0.2
          )
        )
      )
      .slice(0, 2);
    ownOperators(state, [vermeil.id, bubble.id, ...normalFactoryOperators.map((operator) => operator.id)]);

    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === factory.id)!;

    expect(normalFactoryOperators).toHaveLength(2);
    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === vermeil.id)).toBe(true);
    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === bubble.id)).toBe(true);
  });

  it("does not select more non-suppressing candidates than the room has slots", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory];
    ownAllRoster(state);

    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === factory.id)!;

    expect(factoryPlan.assignments.length).toBeLessThanOrEqual(factory.slotCount);
  });

  it("does not report a candidate shortage when owned operators can cover every facility slot", () => {
    const state = createDefaultState();
    ownOperators(
      state,
      operators.slice(0, 150).map((operator) => operator.id)
    );

    const plan = generateAssignmentPlan(state);

    expect(plan.warnings).toEqual([]);
  });

  it("reports a candidate shortage when owned operators cannot cover a facility's slots", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory];
    ownOperators(state, [defaultOwnedGoldFactoryOperator.id]);

    const plan = generateAssignmentPlan(state);

    expect(plan.warnings).toHaveLength(1);
  });

  it("can replace a normal factory worker with a negative capacity partner when the room gains output", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.facilities = [factory];
    const normalFactoryOperators = operators
      .filter((operator) =>
        operator.skills.some((skill) =>
          skill.effects.some(
            (effect) =>
              skill.unlockPhase <= 2 &&
              operator.id !== vermeil.id &&
              operator.id !== vulcan.id &&
              effect.facility === "factory" &&
              (!effect.product || effect.product === factory.product) &&
              !effect.conditions?.length &&
              !effect.ignoredForOptimization &&
              !effect.suppressesOtherFactoryEfficiency &&
              effect.efficiency >= 0.2 &&
              effect.efficiency <= 0.3
          )
        )
      )
      .slice(0, 2);
    ownOperators(state, [vermeil.id, vulcan.id, ...normalFactoryOperators.map((operator) => operator.id)]);
    state.roster[vulcan.id].elite = 2;

    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === factory.id)!;

    expect(normalFactoryOperators).toHaveLength(2);
    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === vermeil.id)).toBe(true);
    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === vulcan.id)).toBe(true);
  });

  it("does not add other factory productivity when Snegurochka suppresses same-factory effects", () => {
    const state = createDefaultState();
    ownOperators(state, [snegurochka.id, defaultOwnedGoldFactoryOperator.id]);
    state.roster[snegurochka.id].elite = 1;
    state.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    const plan = generateAssignmentPlan(state);
    const factoryPlan = plan.facilityPlans.find((facilityPlan) =>
      facilityPlan.assignments.some((assignment) => assignment.operatorId === snegurochka.id)
    )!;
    const snegurochkaAssignment = factoryPlan.assignments.find((assignment) => assignment.operatorId === snegurochka.id)!;

    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === defaultOwnedGoldFactoryOperator.id)).toBe(false);
    expect(plan.facilityPlans.some((facilityPlan) => facilityPlan.assignments.some((assignment) => assignment.operatorId === defaultOwnedGoldFactoryOperator.id))).toBe(
      true
    );
    expect(snegurochkaAssignment.suppressesOtherFactoryEfficiency).toBe(true);
    expect(snegurochkaAssignment.efficiency).toBeCloseTo(0.1);
    expect(factoryPlan.expectedEfficiency).toBeCloseTo(snegurochkaAssignment.efficiency);
  });

  it("counts trading posts with three Kjerag operators for SilverAsh the Dignified Lord", () => {
    const state = createDefaultState();
    ownOperators(state, [silverashAlter.id, pramanix.id, courier.id, thirdKjeragOperator.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const base = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, pramanix.id), contextAssignment(trading, courier.id)]
    }).find((candidate) => candidate.operatorId === silverashAlter.id)!;
    const withStaleSilverAsh = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [
        contextAssignment(trading, pramanix.id),
        contextAssignment(trading, courier.id),
        contextAssignment(trading, silverashAlter.id)
      ]
    }).find((candidate) => candidate.operatorId === silverashAlter.id)!;
    const withThreeOtherKjerag = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [
        contextAssignment(trading, pramanix.id),
        contextAssignment(trading, courier.id),
        contextAssignment(trading, thirdKjeragOperator.id)
      ]
    }).find((candidate) => candidate.operatorId === silverashAlter.id)!;

    expect(pramanix.affiliations).toContain("kjerag");
    expect(courier.affiliations).toContain("kjerag");
    expect(thirdKjeragOperator.affiliations).toContain("kjerag");
    expect(base.efficiency).toBe(0);
    expect(withStaleSilverAsh.efficiency).toBe(0);
    expect(withThreeOtherKjerag.efficiency).toBe(0);
    expect(withThreeOtherKjerag.remoteFacilityEfficiencyBonuses).toContainEqual({
      facility: "trading",
      amount: 0.1,
      product: "lmd",
      groupAffiliations: ["kjerag"],
      min: 3
    });
  });

  it("applies SilverAsh the Dignified Lord's Kjerag boost to matching trading posts", () => {
    const state = createDefaultState();
    ownOperators(state, [silverashAlter.id, courier.id, degenbrecher.id, matterhorn.id]);
    state.facilities = state.facilities.filter((facility) => facility.id === "control-1" || facility.id === "trading-1");
    const plan = generateAssignmentPlan(state);
    const tradingPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "trading-1")!;
    const controlPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "control-1")!;
    const assignedEfficiency = tradingPlan.assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);

    expect(controlPlan.assignments.some((assignment) => assignment.operatorId === silverashAlter.id)).toBe(true);
    expect(tradingPlan.assignments.filter((assignment) => assignment.operatorId !== silverashAlter.id).length).toBe(3);
    expect(tradingPlan.expectedEfficiency - assignedEfficiency).toBeCloseTo(0.1);
  });

  it("uses owned skillless W as a base-wide prerequisite for Hedley's optional bonus", () => {
    const state = createDefaultState();
    ownOperators(state, [hedley.id, ines.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const base = findCandidates(trading, state).find((candidate) => candidate.operatorId === hedley.id)!;
    const withInes = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, ines.id)]
    }).find((candidate) => candidate.operatorId === hedley.id)!;
    state.roster[w.id].owned = true;
    state.roster[w.id].elite = 2;
    const withOwnedW = findCandidates(trading, state).find((candidate) => candidate.operatorId === hedley.id)!;
    const withAssignedW = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, w.id)]
    }).find((candidate) => candidate.operatorId === hedley.id)!;

    expect(w.skills).toHaveLength(0);
    expect(base.efficiency).toBeCloseTo(0.3);
    expect(withInes.efficiency).toBeCloseTo(0.35);
    expect(withOwnedW.efficiency).toBeCloseTo(0.35);
    expect(withOwnedW.skilllessPrerequisiteOperatorIds).toBeUndefined();
    expect(withOwnedW.baseSkilllessPrerequisiteOperatorIds).toContain(w.id);
    expect(withAssignedW.efficiency).toBeCloseTo(0.35);
  });

  it("uses owned skillless Ulpianus as a base-wide prerequisite for Underflow's optional bonus", () => {
    const state = createDefaultState();
    ownOperators(state, [underflow.id, ulpianus.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === underflow.id)!;
    const withAssignedUlpianus = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, ulpianus.id)]
    }).find((assignment) => assignment.operatorId === underflow.id)!;

    expect(ulpianus.skills).toHaveLength(0);
    expect(candidate.efficiency).toBeCloseTo(0.4);
    expect(candidate.skilllessPrerequisiteOperatorIds).toBeUndefined();
    expect(candidate.baseSkilllessPrerequisiteOperatorIds).toContain(ulpianus.id);
    expect(withAssignedUlpianus.efficiency).toBeCloseTo(0.4);
  });

  it("does not spend a trading slot on a base-wide optional skillless prerequisite", () => {
    const state = createDefaultState();
    ownOperators(state, [underflow.id, ulpianus.id, defaultOwnedTradingOperator.id]);
    state.facilities = state.facilities.map((facility) => (facility.id === "trading-1" ? { ...facility, slotCount: 2 } : facility));
    const plan = generateAssignmentPlan(state);
    const tradingPlan = plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "trading-1")!;
    const assignment = tradingPlan.assignments.find((candidate) => candidate.operatorId === underflow.id)!;
    const basePrerequisite = tradingPlan.assignments.find((candidate) => candidate.operatorId === ulpianus.id)!;
    const slotConsumingAssignments = tradingPlan.assignments.filter((candidate) => !candidate.doesNotConsumeFacilitySlot);

    expect(assignment.efficiency).toBeCloseTo(0.4);
    expect(assignment.skilllessPrerequisiteOperatorIds).toBeUndefined();
    expect(assignment.baseSkilllessPrerequisiteOperatorIds).toContain(ulpianus.id);
    expect(basePrerequisite.baseSkilllessPrerequisiteFor).toBe(underflow.id);
    expect(basePrerequisite.doesNotConsumeFacilitySlot).toBe(true);
    expect(slotConsumingAssignments).toHaveLength(2);
    expect(tradingPlan.assignments.some((candidate) => candidate.operatorId === defaultOwnedTradingOperator.id)).toBe(true);
  });

  it("discovers the Lemuen and Exusiai trading post pairing in assignment plans", () => {
    const state = createDefaultState();
    ownOperators(state, [lemuen.id, exusiai.id]);
    const plan = generateAssignmentPlan(state);
    const lemuenAssignment = plan.facilityPlans
      .flatMap((facilityPlan) => facilityPlan.assignments)
      .find((assignment) => assignment.operatorId === lemuen.id)!;
    const exusiaiAssignment = plan.facilityPlans
      .flatMap((facilityPlan) => facilityPlan.assignments)
      .find((assignment) => assignment.operatorId === exusiai.id)!;

    expect(lemuenAssignment.facilityId).toBe(exusiaiAssignment.facilityId);
    expect(lemuenAssignment.skillId).toBe(lemuenExusiaiSkill.id);
    expect(lemuenAssignment.efficiency).toBeCloseTo(0.45);
  });

  it("matches originium factory skills only to originium products", () => {
    const state = createDefaultState();
    ownOperators(state, [eyjafjalla.id, lava.id]);
    state.roster[lava.id].elite = 1;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const goldFactory: FacilitySlot = { ...factory, product: "gold" };
    const battleRecordFactory: FacilitySlot = { ...factory, product: "battleRecord" };
    const originiumFactory: FacilitySlot = { ...factory, product: "originium" };
    const goldCandidateIds = findCandidates(goldFactory, state).map((candidate) => candidate.operatorId);
    const battleRecordCandidateIds = findCandidates(battleRecordFactory, state).map((candidate) => candidate.operatorId);
    const originiumCandidateIds = findCandidates(originiumFactory, state).map((candidate) => candidate.operatorId);

    expect(goldCandidateIds).not.toContain(eyjafjalla.id);
    expect(goldCandidateIds).not.toContain(lava.id);
    expect(battleRecordCandidateIds).not.toContain(eyjafjalla.id);
    expect(battleRecordCandidateIds).not.toContain(lava.id);
    expect(originiumCandidateIds).toEqual(expect.arrayContaining([eyjafjalla.id, lava.id]));
  });

  it("does not change base scores from potential", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.roster[defaultOwnedGoldFactoryOperator.id].owned = true;
    state.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    state.roster[defaultOwnedGoldFactoryOperator.id].potential = 1;
    const baseScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id)!
      .score;

    state.roster[defaultOwnedGoldFactoryOperator.id].potential = 6;
    const maxPotentialScore = findCandidates(factory, state).find(
      (candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id
    )!.score;

    expect(maxPotentialScore).toBe(baseScore);
  });

  it("does not change base scores from level or module state", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.roster[defaultOwnedGoldFactoryOperator.id].owned = true;
    state.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    state.roster[defaultOwnedGoldFactoryOperator.id].level = 1;
    state.roster[defaultOwnedGoldFactoryOperator.id].moduleEnabled = false;
    const baseScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id)!
      .score;

    state.roster[defaultOwnedGoldFactoryOperator.id].level = 90;
    state.roster[defaultOwnedGoldFactoryOperator.id].moduleEnabled = true;
    const maxedScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id)!
      .score;

    expect(maxedScore).toBe(baseScore);
  });

  it("does not apply elite bonuses beyond rarity limits", () => {
    const state = createDefaultState();
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    state.roster[lowRarityPowerOperator.id].owned = true;
    state.roster[lowRarityPowerOperator.id].elite = 0;
    const baseScore = findCandidates(power, state).find((candidate) => candidate.operatorId === lowRarityPowerOperator.id)!.score;

    state.roster[lowRarityPowerOperator.id].elite = 2;
    const cappedScore = findCandidates(power, state).find((candidate) => candidate.operatorId === lowRarityPowerOperator.id)!.score;

    expect(cappedScore).toBe(baseScore);
  });

  it("uses a two-window rotation plan by default", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const plan = generateAssignmentPlan(state);

    expect(state.rotationCount).toBe(2);
    expect(plan.rotation).toHaveLength(2);
    expect(plan.rotation[0].assignments.length).toBeGreaterThan(0);
    expect(plan.rotation[1].recovery.length).toBeGreaterThan(0);
  });

  it("keeps facility assignments stable when the facility list order changes", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const reversedState = structuredClone(state);
    reversedState.facilities.reverse();

    const signature = (plan: ReturnType<typeof generateAssignmentPlan>) =>
      plan.facilityPlans
        .flatMap((facilityPlan) => [
          ...facilityPlan.assignments.map((assignment) => `active:${facilityPlan.facility.id}:${assignment.operatorId}`),
          ...facilityPlan.alternatives.map((assignment) => `alternative:${facilityPlan.facility.id}:${assignment.operatorId}`)
        ])
        .sort();

    expect(signature(generateAssignmentPlan(reversedState))).toEqual(signature(generateAssignmentPlan(state)));
  });

  it("does not reuse operators between first and second rotation assignments", () => {
    const state = createDefaultState();
    ownAllRoster(state);
    const plan = generateAssignmentPlan(state);
    const firstRotationIds = new Set(plan.facilityPlans.flatMap((facilityPlan) => facilityPlan.assignments.map((assignment) => assignment.operatorId)));
    const secondRotationAssignments = plan.facilityPlans.flatMap((facilityPlan) =>
      assignmentsForFacilitySlots(facilityPlan.alternatives, facilityPlan.facility.slotCount)
    );
    const secondRotationIds = secondRotationAssignments.map((assignment) => assignment.operatorId);

    expect(secondRotationAssignments.length).toBeGreaterThan(0);
    expect(secondRotationIds.every((operatorId) => !firstRotationIds.has(operatorId))).toBe(true);
    expect(new Set(secondRotationIds).size).toBe(secondRotationIds.length);
  });

  it("evaluates alternative rotation conditions from alternative assignments only", () => {
    const state = createDefaultState();
    ownOperators(state, [lemuen.id, exusiai.id]);
    const trading = { ...state.facilities.find((facility) => facility.id === "trading-1")!, slotCount: 1 };
    state.facilities = [trading];
    const firstRotationPlan: FacilityPlan = {
      facility: trading,
      assignments: [contextAssignment(trading, exusiai.id, { efficiency: 0.35, score: 35 })],
      expectedEfficiency: 0.35,
      score: 35,
      alternatives: []
    };

    const planWithAlternatives = attachRotationAlternatives(state, [firstRotationPlan])[0];
    const lemuenAlternative = planWithAlternatives.alternatives.find((assignment) => assignment.operatorId === lemuen.id)!;

    expect(planWithAlternatives.alternatives.some((assignment) => assignment.operatorId === exusiai.id)).toBe(false);
    expect(lemuenAlternative.skillId).toBe(lemuenExusiaiSkill.id);
    expect(lemuenAlternative.efficiency).toBeCloseTo(0.2);
    expect(planWithAlternatives.alternativeExpectedEfficiency).toBeCloseTo(0.2);
  });

  it("excludes dormitories from production assignment plans", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const plan = generateAssignmentPlan(state);

    expect(state.facilities.some((facility) => facility.type === "dormitory")).toBe(true);
    expect(plan.facilityPlans.every((facilityPlan) => facilityPlan.facility.type !== "dormitory")).toBe(true);
  });

  it("round-trips exported state json", () => {
    const state = createDefaultState();
    state.roster.char_002_amiya.owned = true;
    state.roster.char_002_amiya.elite = 2;
    state.language = "en";
    state.layout = "153";
    state.rotationCount = 2;
    state.facilities = createFacilitiesForLayout("153", state.facilities);

    const restored = importState(exportState(state));

    expect(restored.roster.char_002_amiya.owned).toBe(true);
    expect(restored.roster.char_002_amiya.elite).toBe(2);
    expect(restored.language).toBe("en");
    expect(restored.layout).toBe("153");
    expect(restored.rotationCount).toBe(2);
    expect(restored.facilities).toHaveLength(state.facilities.length);
  });

  it("clamps imported elite phases to rarity limits", () => {
    const state = createDefaultState();
    state.roster[threeStarOperator.id].elite = 2;
    state.roster[lowRarityOperator.id].elite = 2;

    const restored = importState(exportState(state));

    expect(restored.roster[threeStarOperator.id].elite).toBe(1);
    expect(restored.roster[lowRarityOperator.id].elite).toBe(0);
  });

  it("defaults invalid imported numeric ranges and malformed nested values", () => {
    const defaults = createDefaultState();
    const restored = importState(
      JSON.stringify({
        state: {
          roster: {
            [amiya.id]: {
              owned: "yes",
              elite: 99,
              level: 9001,
              potential: -1,
              moduleEnabled: "true"
            }
          },
          facilities: [
            { type: "factory", product: "invalid", slotCount: 100 },
            { type: "factory", product: "gold", slotCount: 100 }
          ],
          preference: { gold: 2, battleRecord: -0.1, lmd: "heavy" }
        }
      })
    );

    expect(restored.preference).toEqual(defaults.preference);
    expect(restored.roster[amiya.id]).toEqual(defaults.roster[amiya.id]);
    expect(restored.facilities.every((facility) => typeof facility.slotCount === "number")).toBe(true);
    expect(restored.facilities.some((facility) => facility.type === "factory" && facility.product === "gold")).toBe(true);
  });

  it("rejects JSON without a recognizable app state shape", () => {
    expect(() => importState(JSON.stringify({ hello: "world" }))).toThrow();
  });

  it("rejects language-only import payloads", () => {
    expect(() => importState(JSON.stringify({ language: "en" }))).toThrow();
    expect(() => importState(JSON.stringify({ state: { language: "en" } }))).toThrow();
  });
});
