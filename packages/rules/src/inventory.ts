import { RulesError } from './errors';
import type { Combatant } from './schemas';

function sameItem(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function addItem(combatant: Combatant, name: string, quantity = 1): Combatant {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RulesError(`Quantity must be a positive integer, got ${quantity}`);
  }
  const existing = combatant.inventory.find((item) => sameItem(item.name, name));
  const inventory = existing
    ? combatant.inventory.map((item) =>
        item === existing ? { ...item, quantity: item.quantity + quantity } : item
      )
    : [...combatant.inventory, { name: name.trim(), quantity }];
  return { ...combatant, inventory };
}

export function removeItem(combatant: Combatant, name: string, quantity = 1): Combatant {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RulesError(`Quantity must be a positive integer, got ${quantity}`);
  }
  const existing = combatant.inventory.find((item) => sameItem(item.name, name));
  if (!existing || existing.quantity < quantity) {
    const held = existing?.quantity ?? 0;
    throw new RulesError(`${combatant.name} has ${held} × "${name}", cannot remove ${quantity}`);
  }
  const inventory =
    existing.quantity === quantity
      ? combatant.inventory.filter((item) => item !== existing)
      : combatant.inventory.map((item) =>
          item === existing ? { ...item, quantity: item.quantity - quantity } : item
        );
  return { ...combatant, inventory };
}
