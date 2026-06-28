import { describe, expect, it } from "vitest";
import { createDefaultState, createFacilitiesForLayout, operators } from "../data/defaults";
import { exportState, importState } from "./storage";
import { findCandidates, generateAssignmentPlan } from "./optimizer";
import type { Assignment, FacilitySlot } from "../types";

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
      skill.effects.some((effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold"))
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
const silverashAlter = operators.find((operator) => operator.id === "char_1045_svash2")!;
const pramanix = operators.find((operator) => operator.id === "char_174_slbell")!;
const courier = operators.find((operator) => operator.id === "char_198_blackd")!;
const hedley = operators.find((operator) => operator.id === "char_4088_hodrer")!;
const ines = operators.find((operator) => operator.id === "char_4087_ines")!;
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
const archetto = operators.find((operator) => operator.id === "char_332_archet")!;
const minimalist = operators.find((operator) => operator.id === "char_4054_malist")!;
const greyyAlter = operators.find((operator) => operator.id === "char_1027_greyy2")!;
const alanna = operators.find((operator) => operator.id === "char_4178_alanna")!;
const lancet = operators.find((operator) => operator.id === "char_285_medic2")!;
const justiceKnight = operators.find((operator) => operator.id === "char_4000_jnight")!;
const vigil = operators.find((operator) => operator.id === "char_427_vigil")!;
const vermeil = operators.find((operator) => operator.id === "char_190_clour")!;
const bubble = operators.find((operator) => operator.id === "char_381_bubble")!;
const degenbrecher = operators.find((operator) => operator.id === "char_4116_blkkgt")!;
const obliviator = operators.find((operator) => operator.id === "char_4182_oblvns")!;
const mortis = operators.find((operator) => operator.id === "char_4183_mortis")!;

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

describe("optimizer", () => {
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

    expect(glasgowOperator.affiliations).toContain("glasgow");
    expect(findCandidates(control, state).some((candidate) => candidate.skillId === delphineGlasgowSkill.id)).toBe(false);
    expect(
      findCandidates(control, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, glasgowOperator.id)]
      }).some((candidate) => candidate.skillId === delphineGlasgowSkill.id)
    ).toBe(true);
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
    expect(gladiiaCandidate.efficiency).toBeCloseTo(0.08);
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
    expect(chenBase.efficiency).toBeCloseTo(0.08);
    expect(chenWithLgd.efficiency).toBeCloseTo(0.13);
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
    expect(ashBase.efficiency).toBeCloseTo(0.08);
    expect(ashWithRainbowSquad.efficiency).toBeCloseTo(0.18);
  });

  it("requires Hedley in a trading post for Wis'adel's control center order bonus", () => {
    const state = createDefaultState();
    ownOperators(state, [wisadel.id, hedley.id]);
    state.roster[wisadel.id].elite = 0;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(findCandidates(control, state).some((candidate) => candidate.skillId === wisadelHedleySkill.id)).toBe(false);
    expect(
      findCandidates(control, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, hedley.id)]
      }).some((candidate) => candidate.skillId === wisadelHedleySkill.id)
    ).toBe(true);
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
    expect(morganBase.efficiency).toBeCloseTo(0.23);
    expect(morganWithSiege.skillId).toBe(morganGlasgowSkill.id);
    expect(morganWithSiege.efficiency).toBeCloseTo(0.78);
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
    expect(typhonBase.efficiency).toBeCloseTo(0.13);
    expect(typhonWithSami.efficiency).toBeCloseTo(0.18);
    expect(valarqvinBase.efficiency).toBeCloseTo(0.13);
    expect(valarqvinWithTyphon.efficiency).toBeCloseTo(0.28);
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
    expect(rosaBase.efficiency).toBeCloseTo(0.08);
    expect(rosaWithStudent.efficiency).toBeCloseTo(0.13);
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

    expect(withoutExusiaiContext.efficiency).toBeCloseTo(0.23);
    expect(withExusiaiContext.skillId).toBe(lemuenExusiaiSkill.id);
    expect(withExusiaiContext.efficiency).toBeCloseTo(0.48);
  });

  it("uses skillless referenced operators to satisfy named operator conditions", () => {
    const state = createDefaultState();
    ownOperators(state, [vulpisfoglia.id, suzuran.id]);
    const reception: FacilitySlot = { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" };
    const withoutSuzuran = findCandidates(reception, state).find((candidate) => candidate.operatorId === vulpisfoglia.id)!;
    const withSuzuran = findCandidates(reception, state, 0, {
      facilities: [...state.facilities, reception],
      assignments: [contextAssignment(reception, suzuran.id)]
    }).find((candidate) => candidate.operatorId === vulpisfoglia.id)!;

    expect(suzuran.skills).toHaveLength(0);
    expect(withoutSuzuran.skillId).not.toBe(vulpisfogliaSuzuranSkill.id);
    expect(withSuzuran.skillId).toBe(vulpisfogliaSuzuranSkill.id);
    expect(withSuzuran.efficiency).toBeGreaterThan(withoutSuzuran.efficiency);
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
    expect(base.efficiency).toBeCloseTo(0.13);
    expect(withRhine.efficiency).toBeCloseTo(0.16);
  });

  it("scales Eunectes factory productivity by power plant count", () => {
    const state = createDefaultState();
    ownOperators(state, [eunectes.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === eunectes.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.33);
  });

  it("scales Snegurochka by every operator assigned to the same factory", () => {
    const state = createDefaultState();
    ownOperators(state, [snegurochka.id, texas.id, lappland.id]);
    state.roster[snegurochka.id].elite = 1;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(factory, texas.id), contextAssignment(factory, lappland.id)]
    }).find((assignment) => assignment.operatorId === snegurochka.id)!;

    expect(candidate.suppressesOtherFactoryEfficiency).toBe(true);
    expect(candidate.efficiency).toBeCloseTo(0.315);
  });

  it("uses max facility level for reception-level scaling skills", () => {
    const state = createDefaultState();
    ownOperators(state, [vigil.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === vigil.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.43);
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
    expect(alannaBase.efficiency).toBeCloseTo(0.03);
    expect(alannaWithPlatforms.efficiency).toBeCloseTo(0.23);
  });

  it("uses modeled drone cap assumptions for Greyy the Lightningbearer's power skill", () => {
    const state = createDefaultState();
    ownOperators(state, [greyyAlter.id]);
    const power = state.facilities.find((facility) => facility.id === "power-1")!;
    const candidate = findCandidates(power, state).find((assignment) => assignment.operatorId === greyyAlter.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.23);
  });

  it("uses max steady-state values for time-ramping factory skills", () => {
    const state = createDefaultState();
    ownOperators(state, [fang.id]);
    state.roster[fang.id].elite = 0;
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === fang.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.25);
  });

  it("uses max total dormitory level for dorm-level scaling skills", () => {
    const state = createDefaultState();
    ownOperators(state, [archetto.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const candidate = findCandidates(trading, state).find((assignment) => assignment.operatorId === archetto.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.43);
  });

  it("folds max construction robot count into Minimalist's production skill", () => {
    const state = createDefaultState();
    ownOperators(state, [minimalist.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidate = findCandidates(factory, state).find((assignment) => assignment.operatorId === minimalist.id)!;

    expect(candidate.efficiency).toBeCloseTo(0.43);
  });

  it("applies Lee's control-center clue speed bonus to reception assignments", () => {
    const state = createDefaultState();
    ownOperators(state, [lee.id, may.id]);
    state.facilities = [
      ...state.facilities,
      { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" }
    ];
    const plan = generateAssignmentPlan(state);
    const receptionAssignment = plan.facilityPlans
      .find((facilityPlan) => facilityPlan.facility.type === "reception")!
      .assignments.find((assignment) => assignment.operatorId === may.id)!;

    expect(plan.facilityPlans.some((facilityPlan) => facilityPlan.assignments.some((assignment) => assignment.operatorId === lee.id))).toBe(true);
    expect(receptionAssignment.efficiency).toBeCloseTo(0.48);
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
    expect(base.efficiency).toBeCloseTo(0.19);
    expect(withStoragePartner.efficiency).toBeCloseTo(0.39);
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

    expect(base.efficiency).toBeCloseTo(0.28);
    expect(withOrderLimit.efficiency).toBeCloseTo(0.53);
  });

  it("scales Sakiko Togawa's gold factory control effect from passion", () => {
    const baseState = createDefaultState();
    ownOperators(baseState, [obliviator.id, defaultOwnedGoldFactoryOperator.id]);
    baseState.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    const basePlan = generateAssignmentPlan(baseState);
    const baseGoldAssignment = basePlan.facilityPlans
      .find((facilityPlan) => facilityPlan.facility.product === "gold")!
      .assignments.find((assignment) => assignment.operatorId === defaultOwnedGoldFactoryOperator.id)!;

    const passionState = createDefaultState();
    ownOperators(passionState, [obliviator.id, mortis.id, defaultOwnedGoldFactoryOperator.id]);
    passionState.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    const passionPlan = generateAssignmentPlan(passionState);
    const passionGoldAssignment = passionPlan.facilityPlans
      .find((facilityPlan) => facilityPlan.facility.product === "gold")!
      .assignments.find((assignment) => assignment.operatorId === defaultOwnedGoldFactoryOperator.id)!;

    expect(passionGoldAssignment.efficiency - baseGoldAssignment.efficiency).toBeCloseTo(0.01);
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

    expect(factoryPlan.assignments.some((assignment) => assignment.operatorId === defaultOwnedGoldFactoryOperator.id)).toBe(true);
    expect(snegurochkaAssignment.suppressesOtherFactoryEfficiency).toBe(true);
    expect(factoryPlan.expectedEfficiency).toBeCloseTo(snegurochkaAssignment.efficiency);
  });

  it("counts trading posts with three Kjerag operators for SilverAsh the Dignified Lord", () => {
    const state = createDefaultState();
    ownOperators(state, [silverashAlter.id, pramanix.id, courier.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const base = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(trading, pramanix.id), contextAssignment(trading, courier.id)]
    }).find((candidate) => candidate.operatorId === silverashAlter.id)!;
    const withThreeKjerag = findCandidates(control, state, 0, {
      facilities: state.facilities,
      assignments: [
        contextAssignment(trading, pramanix.id),
        contextAssignment(trading, courier.id),
        contextAssignment(trading, silverashAlter.id)
      ]
    }).find((candidate) => candidate.operatorId === silverashAlter.id)!;

    expect(pramanix.affiliations).toContain("kjerag");
    expect(courier.affiliations).toContain("kjerag");
    expect(base.efficiency).toBeCloseTo(0.03);
    expect(withThreeKjerag.efficiency).toBeCloseTo(0.13);
  });

  it("adds Hedley's Ines bonus when Ines is assigned anywhere in the base", () => {
    const state = createDefaultState();
    ownOperators(state, [hedley.id, ines.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const base = findCandidates(trading, state).find((candidate) => candidate.operatorId === hedley.id)!;
    const withInes = findCandidates(trading, state, 0, {
      facilities: state.facilities,
      assignments: [contextAssignment(control, ines.id)]
    }).find((candidate) => candidate.operatorId === hedley.id)!;

    expect(base.efficiency).toBeCloseTo(0.33);
    expect(withInes.efficiency).toBeCloseTo(0.38);
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
    expect(lemuenAssignment.efficiency).toBeCloseTo(0.48);
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

  it("does not reuse operators between first and second rotation assignments", () => {
    const state = createDefaultState();
    ownAllRoster(state);
    const plan = generateAssignmentPlan(state);
    const firstRotationIds = new Set(plan.facilityPlans.flatMap((facilityPlan) => facilityPlan.assignments.map((assignment) => assignment.operatorId)));
    const secondRotationAssignments = plan.facilityPlans.flatMap((facilityPlan) =>
      facilityPlan.alternatives.slice(0, facilityPlan.facility.slotCount)
    );
    const secondRotationIds = secondRotationAssignments.map((assignment) => assignment.operatorId);

    expect(secondRotationAssignments.length).toBeGreaterThan(0);
    expect(secondRotationIds.every((operatorId) => !firstRotationIds.has(operatorId))).toBe(true);
    expect(new Set(secondRotationIds).size).toBe(secondRotationIds.length);
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
});
