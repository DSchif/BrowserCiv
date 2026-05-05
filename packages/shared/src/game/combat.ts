import type { ContentPack, UnitDef } from "../schemas/index.js";
import type { Unit } from "./state.js";

/** Attack shape — matches UnitDef.attacks[] (plain strings, not branded TypeIds). */
export type Attack = UnitDef["attacks"][number];

export function diplomacyKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export interface CombatResult {
  attackerDamage: number;
  defenderDamage: number;
  attackerKilled: boolean;
  defenderKilled: boolean;
  /** Effectiveness multiplier applied to defender damage. */
  effectiveness: number;
}

const ZERO_RESULT: CombatResult = {
  attackerDamage: 0,
  defenderDamage: 0,
  attackerKilled: false,
  defenderKilled: false,
  effectiveness: 1,
};

function defOf(content: ContentPack, defId: string): UnitDef | undefined {
  return content.units.find((u) => (u.id as unknown as string) === defId);
}

/**
 * Derive the unit's defensive types — explicit list if set, otherwise inferred
 * from `traits` (so existing units work without authoring overhead).
 */
export function getUnitTypes(def: UnitDef): string[] {
  const explicit = def.unit_types?.map((t) => t as unknown as string) ?? [];
  if (explicit.length > 0) return explicit;
  const traits = def.traits.map((t) => t as unknown as string);
  const out: string[] = [];
  if (traits.includes("infantry")) out.push("type.infantry");
  if (traits.includes("mounted")) out.push("type.cavalry");
  if (traits.includes("siege")) out.push("type.siege_unit");
  if (traits.includes("naval")) out.push("type.naval_unit");
  if (traits.includes("armor")) out.push("type.armored");
  if (traits.includes("settler") || traits.includes("worker")) out.push("type.civilian");
  return out.length > 0 ? out : ["type.civilian"];
}

/**
 * The default attack list for a unit. If `unit.attacks` is empty (legacy units)
 * we synthesize a sensible melee + optional ranged attack using existing
 * `combat.strength` / `combat.ranged_strength` and the unit's traits + era.
 */
export function getUnitAttacks(def: UnitDef): Attack[] {
  if (def.attacks && def.attacks.length > 0) return def.attacks;
  const traits = def.traits.map((t) => t as unknown as string);
  const era = def.era_required as unknown as string;
  const id = def.id as unknown as string;
  const isAntiCav =
    id.includes("spear") || id.includes("pike") || id.includes("lancer");
  const isSiege = traits.includes("siege");
  const isMounted = traits.includes("mounted") && !isAntiCav;
  const isNaval = traits.includes("naval");
  const isGunpowder =
    era === "renaissance" || era === "industrial" || era === "modern" || era === "atomic" || era === "information";

  const out: Attack[] = [];
  if (def.combat.strength > 0) {
    let types: string[] = ["type.melee"];
    if (isAntiCav) types = ["type.anti_cavalry", "type.melee"];
    else if (isMounted) types = ["type.mounted_charge", "type.melee"];
    out.push({
      id: `${id}.melee`,
      name: isMounted ? "Charge" : isAntiCav ? "Brace" : "Strike",
      types,
      range: 1,
      damage: def.combat.strength,
      cooldown: 0,
    });
  }
  if (def.combat.ranged_strength) {
    let types: string[] = ["type.piercing"];
    if (isSiege) types = ["type.siege"];
    else if (isNaval) types = ["type.naval_attack"];
    else if (isGunpowder) types = ["type.gunpowder"];
    out.push({
      id: `${id}.ranged`,
      name: isSiege ? "Bombard" : isNaval ? "Broadside" : isGunpowder ? "Volley" : "Volley",
      types,
      range: def.combat.range ?? 2,
      damage: def.combat.ranged_strength,
      cooldown: 0,
    });
  }
  return out;
}

/** Look up the effectiveness multiplier for an (attack types × defender types) pair. */
export function effectivenessMultiplier(
  attackTypes: string[],
  defenderTypes: string[],
  content: ContentPack,
): number {
  const eff = content.effectiveness ?? [];
  if (eff.length === 0 || attackTypes.length === 0 || defenderTypes.length === 0) return 1;
  // Pokemon-style: multiply across the matrix. Missing pairs = 1.0×.
  let mult = 1;
  for (const aT of attackTypes) {
    for (const dT of defenderTypes) {
      const e = eff.find(
        (x) => (x.attacker as unknown as string) === aT && (x.defender as unknown as string) === dT,
      );
      if (e) mult *= e.multiplier;
    }
  }
  return mult;
}

/** Pick the default attack: first attack with cooldown 0 (or just the first). */
export function defaultAttack(def: UnitDef, range: 1 | "any" = "any"): Attack | null {
  const attacks = getUnitAttacks(def);
  if (range === 1) {
    const m = attacks.find((a) => a.range === 1);
    return m ?? null;
  }
  return attacks[0] ?? null;
}

/**
 * Resolve melee combat using the picked attack. Both sides take damage; the
 * defender's retaliation uses their first melee attack.
 */
export function resolveMelee(
  attacker: Unit,
  defender: Unit,
  content: ContentPack,
  attackerAttack?: Attack,
): CombatResult {
  const aDef = defOf(content, attacker.defId);
  const dDef = defOf(content, defender.defId);
  if (!aDef || !dDef) return ZERO_RESULT;
  const attack = attackerAttack ?? defaultAttack(aDef, 1);
  if (!attack) return ZERO_RESULT;

  const defenderTypes = getUnitTypes(dDef);
  const attackerTypes = getUnitTypes(aDef);

  const aMult = effectivenessMultiplier(attack.types, defenderTypes, content);
  // Defender retaliates with their default melee attack.
  const retaliation = defaultAttack(dDef, 1);
  const dMult = retaliation
    ? effectivenessMultiplier(retaliation.types, attackerTypes, content)
    : 1;

  const aHpRatio = attacker.hp / attacker.hpMax;
  const dHpRatio = defender.hp / defender.hpMax;
  const aFort = attacker.fortified ? 1.25 : 1;
  const dFort = defender.fortified ? 1.25 : 1;

  // Civ-V flavored: 30 base damage at parity, modulated by ratios + multipliers.
  const aPower = attack.damage * aHpRatio * aFort;
  const dPower = (retaliation?.damage ?? dDef.combat.strength) * dHpRatio * dFort;
  if (aPower <= 0 || dPower <= 0) return ZERO_RESULT;

  const ratio = aPower / dPower;
  const defenderDamage = clampHp(Math.round(30 * Math.pow(ratio, 0.5) * aMult));
  const attackerDamage = clampHp(
    Math.round(30 / Math.pow(Math.max(0.01, ratio), 0.5) * dMult),
  );
  const attackerKilled = attacker.hp - attackerDamage <= 0;
  const defenderKilled = defender.hp - defenderDamage <= 0;
  return {
    attackerDamage,
    defenderDamage,
    attackerKilled,
    defenderKilled,
    effectiveness: aMult,
  };
}

/** Ranged attack: one-sided damage scaled by effectiveness. */
export function resolveRanged(
  attacker: Unit,
  defender: Unit,
  content: ContentPack,
  attackerAttack?: Attack,
): CombatResult {
  const aDef = defOf(content, attacker.defId);
  const dDef = defOf(content, defender.defId);
  if (!aDef || !dDef) return ZERO_RESULT;
  const attacks = getUnitAttacks(aDef);
  const attack =
    attackerAttack ?? attacks.find((a) => a.range > 1) ?? null;
  if (!attack || attack.range <= 1) return ZERO_RESULT;
  const defenderTypes = getUnitTypes(dDef);
  const aMult = effectivenessMultiplier(attack.types, defenderTypes, content);
  const aHpRatio = attacker.hp / attacker.hpMax;
  const dHpRatio = defender.hp / defender.hpMax;
  const aPower = attack.damage * aHpRatio;
  const dPower = dDef.combat.strength * dHpRatio;
  if (aPower <= 0 || dPower <= 0) return ZERO_RESULT;
  const ratio = aPower / dPower;
  const defenderDamage = clampHp(Math.round(25 * Math.pow(ratio, 0.5) * aMult));
  return {
    attackerDamage: 0,
    defenderDamage,
    attackerKilled: false,
    defenderKilled: defender.hp - defenderDamage <= 0,
    effectiveness: aMult,
  };
}

function clampHp(n: number): number {
  if (n < 1) return 1;
  if (n > 100) return 100;
  return n;
}

/**
 * Resolve melee attack into a city. Damages the city and the attacker.
 * Returns city damage + attacker damage. The reducer checks city HP for capture.
 */
export interface CityAttackResult {
  cityDamage: number;
  attackerDamage: number;
  attackerKilled: boolean;
  defenderKilled: boolean; // true when city is captured (cityDamage drops it to 0)
}

export function resolveCityAttack(
  attacker: Unit,
  cityHp: number,
  cityHpMax: number,
  cityDefenseStrength: number,
  content: ContentPack,
  attack?: Attack,
): CityAttackResult {
  const aDef = defOf(content, attacker.defId);
  if (!aDef) {
    return { cityDamage: 0, attackerDamage: 0, attackerKilled: false, defenderKilled: false };
  }
  const a = attack ?? defaultAttack(aDef, 1);
  if (!a) return { cityDamage: 0, attackerDamage: 0, attackerKilled: false, defenderKilled: false };

  const aHpRatio = attacker.hp / attacker.hpMax;
  const dHpRatio = cityHp / Math.max(1, cityHpMax);
  const aPower = a.damage * aHpRatio * (attacker.fortified ? 1.25 : 1);
  const dPower = cityDefenseStrength * Math.max(0.4, dHpRatio); // weak cities still bite back a bit

  if (aPower <= 0 || dPower <= 0) {
    return { cityDamage: 0, attackerDamage: 0, attackerKilled: false, defenderKilled: false };
  }

  const ratio = aPower / dPower;
  // City takes more damage per swing than a unit; attacker takes a smaller bite.
  const cityDamage = Math.max(8, Math.round(28 * Math.pow(ratio, 0.5)));
  const attackerDamage = Math.max(4, Math.round(20 / Math.pow(Math.max(0.01, ratio), 0.5)));

  const attackerKilled = attacker.hp - attackerDamage <= 0;
  const defenderKilled = cityHp - cityDamage <= 0;

  return {
    cityDamage: Math.min(cityHp, cityDamage),
    attackerDamage: Math.min(100, attackerDamage),
    attackerKilled,
    defenderKilled,
  };
}

/** City defense strength based on era + buildings. */
export function cityDefenseStrength(
  city: { buildings: string[]; foundedTurn: number },
  content: ContentPack,
  matchTurn: number,
): number {
  // Approximate "era progression by turn" since we don't track per-city era.
  // Each ~60 turns adds 4 strength (matches roughly Civ V's era curve).
  const eraBonus = Math.min(8, Math.floor(matchTurn / 60)) * 4;
  let strength = 10 + eraBonus;
  if (city.buildings.includes("building.walls")) strength += 5;
  if (city.buildings.includes("building.barracks")) strength += 1;
  void content;
  return strength;
}

/**
 * Available city attacks. Default = Bombard. Buildings can add specialized
 * attacks (Walls → Wall Volley with extra damage, Barracks → Garrison Strike
 * for adjacent melee defense). Future buildings/wonders can extend this.
 */
export function getCityAttacks(
  city: { buildings: string[]; foundedTurn: number },
  content: ContentPack,
  matchTurn: number,
): Attack[] {
  const defStr = cityDefenseStrength(city, content, matchTurn);
  const attacks: Attack[] = [];
  attacks.push({
    id: "city.bombard",
    name: "Bombard",
    types: ["type.siege"],
    range: 2,
    damage: defStr,
    cooldown: 0,
  });
  if (city.buildings.includes("building.walls")) {
    attacks.push({
      id: "city.wall_volley",
      name: "Wall Volley",
      types: ["type.siege", "type.piercing"],
      range: 2,
      damage: defStr + 8,
      cooldown: 0,
    });
  }
  if (city.buildings.includes("building.barracks")) {
    attacks.push({
      id: "city.garrison_strike",
      name: "Garrison Strike",
      types: ["type.melee"],
      range: 1,
      damage: Math.max(6, defStr - 4),
      cooldown: 0,
    });
  }
  return attacks;
}

