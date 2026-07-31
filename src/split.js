// Pure math: given state, work out what each person owes.
// - Each item stores per-person "shares" (weights). price is split in
//   proportion to those weights, so "2 for Nikhil, 1 for Priya" => 2:1.
// - An item with no shares set is treated as shared equally by everyone.
// - Extra charges (tax + tip + service − discount) are distributed
//   proportionally to each person's food subtotal.

export function computeTotals(state) {
  const { members, items, charges } = state;
  const memberIds = new Set(members.map((m) => m.id));
  const shares = Object.fromEntries(members.map((m) => [m.id, 0]));
  const itemBreakdown = {}; // itemId -> { memberId: amount }
  let subtotal = 0;
  let unassignedTotal = 0;

  for (const it of items) {
    const price = Number(it.price) || 0;
    if (price) subtotal += price;

    const entries = Object.entries(it.shares || {}).filter(
      ([id, w]) => memberIds.has(id) && Number(w) > 0,
    );

    let dist;
    if (entries.length) {
      const totalW = entries.reduce((s, [, w]) => s + Number(w), 0);
      dist = entries.map(([id, w]) => [id, (price * Number(w)) / totalW]);
    } else if (members.length) {
      // nobody tagged -> shared equally by everyone
      dist = members.map((m) => [m.id, price / members.length]);
      if (price) unassignedTotal += price;
    } else {
      dist = [];
    }

    const bd = {};
    dist.forEach(([id, amt]) => {
      shares[id] += amt;
      bd[id] = amt;
    });
    itemBreakdown[it.id] = bd;
  }

  const tax = Number(charges.tax) || 0;
  const tip = Number(charges.tip) || 0;
  const service = Number(charges.service) || 0;
  const discount = Number(charges.discount) || 0;
  const extras = tax + tip + service - discount;

  const perMember = members.map((m) => {
    const food = shares[m.id];
    const extraShare =
      subtotal > 0
        ? extras * (food / subtotal)
        : members.length
          ? extras / members.length
          : 0;
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      food,
      extra: extraShare,
      total: food + extraShare,
    };
  });

  return {
    perMember,
    subtotal,
    extras,
    grand: subtotal + extras,
    unassignedTotal,
    itemBreakdown,
  };
}
