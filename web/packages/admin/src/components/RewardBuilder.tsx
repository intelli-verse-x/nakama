"use client";

import { useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  Coins,
  Sparkles,
  Package,
  Battery,
  Gift,
  Zap,
  Plus,
  Minus,
  Trash2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Copy,
  CheckCircle2,
  AlertCircle,
  Info,
  Battery as BatteryIcon,
} from "lucide-react";

export interface RewardBuilderReward {
  currencies?: Record<string, number>;
  items?: Record<string, number>;
  energies?: Record<string, number>;
  xp?: number;
  gifts?: GiftReward[];
  energyModifiers?: Modifier[];
  rewardModifiers?: Modifier[];
}

export interface GiftReward {
  id: string;
  name: string;
  description?: string;
  type: "physical" | "voucher" | "experience" | "digital" | "merch";
  value?: string;
  quantity?: number;
  assetUrl?: string;
  ctaLabel?: string;
  deliverEmail?: boolean;
}

export interface Modifier {
  id: string;
  operator: "add" | "multiply";
  value: number;
  durationSec: number;
}

const CURRENCY_OPTIONS = [
  { id: "game", label: "Game Coins", icon: Coins, color: "text-amber-400" },
  { id: "tokens", label: "Tokens (legacy)", icon: Coins, color: "text-amber-400" },
  { id: "global", label: "Global Points (XUT)", icon: Sparkles, color: "text-violet-400" },
  { id: "xut", label: "XUT (alias)", icon: Sparkles, color: "text-violet-400" },
  { id: "xp", label: "XP", icon: Zap, color: "text-emerald-400" },
] as const;

const GIFT_TYPES = [
  { value: "voucher", label: "🎁 Voucher / Gift Card", icon: Gift },
  { value: "digital", label: "💾 Digital Asset", icon: Package },
  { value: "physical", label: "📦 Physical Item", icon: Package },
  { value: "experience", label: "🎮 Experience / Access", icon: Sparkles },
  { value: "merch", label: "👕 Merchandise", icon: Package },
] as const;

const COMMON_ITEMS = [
  "character_quizzy",
  "character_legendary",
  "character_epic",
  "skin_rare",
  "skin_legendary",
  "powerup_hint",
  "powerup_skip",
  "powerup_double_xp",
  "badge_champion",
  "badge_collector",
  "badge_streak_master",
] as const;

const ENERGY_TYPES = [
  "stamina",
  "energy",
  "hearts",
  "tickets",
] as const;

function NumberInput(props: React.InputHTMLAttributes<HTMLInputElement> & { min?: number; step?: number }) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          const current = parseFloat(props.value as string) || 0;
          const step = props.step || 1;
          const min = props.min || 0;
          const next = Math.max(min, current - step);
          (props.onChange as any)({ target: { value: next.toString() } });
        }}
        className="p-1 rounded hover:bg-accent text-muted-foreground"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <input
        {...props}
        type="number"
        className="w-20 text-center border-0 bg-transparent focus:ring-0 focus:outline-none text-sm"
      />
      <button
        type="button"
        onClick={() => {
          const current = parseFloat(props.value as string) || 0;
          const step = props.step || 1;
          (props.onChange as any)({ target: { value: (current + step).toString() } });
        }}
        className="p-1 rounded hover:bg-accent text-muted-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function RewardBuilder({
  value,
  onChange,
  readOnly = false,
}: {
  value: RewardBuilderReward;
  onChange: (reward: RewardBuilderReward) => void;
  readOnly?: boolean;
}) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    currencies: true,
    items: true,
    energies: false,
    xp: true,
    gifts: false,
    modifiers: false,
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const updateReward = useCallback((partial: Partial<RewardBuilderReward>) => {
    onChange({ ...value, ...partial });
  }, [value, onChange]);

  const currencies = value.currencies || {};
  const handleCurrencyChange = (currencyId: string, amount: number) => {
    const newCurrencies = { ...currencies };
    if (amount > 0) newCurrencies[currencyId] = amount;
    else delete newCurrencies[currencyId];
    updateReward({ currencies: newCurrencies });
  };

  const items = value.items || {};
  const [newItemId, setNewItemId] = useState("");
  const handleItemChange = (itemId: string, count: number) => {
    const newItems = { ...items };
    if (count > 0) newItems[itemId] = count;
    else delete newItems[itemId];
    updateReward({ items: newItems });
  };
  const addCustomItem = () => {
    if (newItemId.trim()) {
      handleItemChange(newItemId.trim(), 1);
      setNewItemId("");
    }
  };

  const energies = value.energies || {};
  const handleEnergyChange = (energyId: string, amount: number) => {
    const newEnergies = { ...energies };
    if (amount > 0) newEnergies[energyId] = amount;
    else delete newEnergies[energyId];
    updateReward({ energies: newEnergies });
  };

  const handleXpChange = (xp: number) => {
    updateReward({ xp: xp > 0 ? xp : undefined });
  };

  const gifts = value.gifts || [];
  const [newGift, setNewGift] = useState<Partial<GiftReward>>({
    type: "voucher",
    quantity: 1,
  });
  const handleGiftChange = (index: number, field: keyof GiftReward, val: any) => {
    const newGifts = [...gifts];
    newGifts[index] = { ...newGifts[index], [field]: val } as GiftReward;
    updateReward({ gifts: newGifts });
  };
  const addGift = () => {
    if (newGift.id && newGift.name) {
      updateReward({ gifts: [...gifts, newGift as GiftReward] });
      setNewGift({ type: "voucher", quantity: 1 });
    }
  };
  const removeGift = (index: number) => {
    const newGifts = gifts.filter((_, i) => i !== index);
    updateReward({ gifts: newGifts });
  };

  const energyModifiers = value.energyModifiers || [];
  const rewardModifiers = value.rewardModifiers || [];
  const handleModifierChange = (type: "energyModifiers" | "rewardModifiers", index: number, field: keyof Modifier, val: any) => {
    const arr = type === "energyModifiers" ? energyModifiers : rewardModifiers;
    const newArr = [...arr];
    newArr[index] = { ...newArr[index], [field]: val };
    updateReward({ [type]: newArr });
  };
  const addModifier = (type: "energyModifiers" | "rewardModifiers") => {
    const arr = type === "energyModifiers" ? energyModifiers : rewardModifiers;
    updateReward({ [type]: [...arr, { id: "", operator: "multiply", value: 1.5, durationSec: 3600 }] });
  };
  const removeModifier = (type: "energyModifiers" | "rewardModifiers", index: number) => {
    const arr = type === "energyModifiers" ? energyModifiers : rewardModifiers;
    const newArr = arr.filter((_, i) => i !== index);
    updateReward({ [type]: newArr });
  };

  const previewJson = useMemo(() => {
    const reward: any = {};
    if (Object.keys(currencies).length > 0) reward.currencies = currencies;
    if (Object.keys(items).length > 0) reward.items = items;
    if (Object.keys(energies).length > 0) reward.energies = energies;
    if (value.xp) reward.xp = value.xp;
    if (gifts.length > 0) reward.gifts = gifts;
    if (energyModifiers.length > 0) reward.energyModifiers = energyModifiers;
    if (rewardModifiers.length > 0) reward.rewardModifiers = rewardModifiers;
    return JSON.stringify(reward, null, 2);
  }, [currencies, items, energies, value.xp, gifts, energyModifiers, rewardModifiers]);

  const hasAnyReward = useMemo(() => 
    Object.keys(currencies).length > 0 ||
    Object.keys(items).length > 0 ||
    Object.keys(energies).length > 0 ||
    (value.xp ?? 0) > 0 ||
    gifts.length > 0 ||
    energyModifiers.length > 0 ||
    rewardModifiers.length > 0,
    [currencies, items, energies, value.xp, gifts, energyModifiers, rewardModifiers]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", hasAnyReward ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400")}>
          {hasAnyReward ? "✓ Reward Configured" : "⚠ No Reward Set"}
        </span>
        <span className="text-muted-foreground">— Supports currencies, items, energy, XP, gift cards, and modifiers</span>
      </div>

      <RewardSection
        title="Currencies"
        icon={Coins}
        iconColor="text-amber-400"
        expanded={expandedSections.currencies}
        onToggle={() => toggleSection("currencies")}
        readOnly={readOnly}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CURRENCY_OPTIONS.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-3 rounded-lg border border-border bg-background/50">
              <c.icon className={cn("h-4 w-4", c.color)} />
              <div className="flex-1 min-w-0">
                <label className="text-xs font-medium text-foreground">{c.label}</label>
                <NumberInput
                  min={0}
                  value={currencies[c.id] || 0}
                  onChange={(e) => handleCurrencyChange(c.id, parseInt(e.target.value) || 0)}
                  disabled={readOnly}
                />
              </div>
            </div>
          ))}
        </div>
      </RewardSection>

      <RewardSection
        title="XP (Experience Points)"
        icon={Zap}
        iconColor="text-emerald-400"
        expanded={expandedSections.xp}
        onToggle={() => toggleSection("xp")}
        readOnly={readOnly}
      >
        <div className="flex items-center gap-3">
          <Zap className="h-4 w-4 text-emerald-400" />
          <label className="text-xs font-medium text-foreground">XP Amount</label>
          <NumberInput
            min={0}
            value={value.xp || 0}
            onChange={(e) => handleXpChange(parseInt(e.target.value) || 0)}
            disabled={readOnly}
          />
        </div>
      </RewardSection>

      <RewardSection
        title="Inventory Items"
        icon={Package}
        iconColor="text-sky-400"
        expanded={expandedSections.items}
        onToggle={() => toggleSection("items")}
        readOnly={readOnly}
      >
        <div className="space-y-2">
          {Object.entries(items).map(([itemId, count]) => (
            <div key={itemId} className="flex items-center gap-2 p-2 rounded-lg border border-border bg-background/50">
              <Package className="h-4 w-4 text-sky-400" />
              <input
                type="text"
                value={itemId}
                className="flex-1 min-w-0 rounded border border-transparent bg-background px-2 py-1 text-sm font-mono"
                readOnly
              />
              <NumberInput
                min={1}
                value={count}
                onChange={(e) => handleItemChange(itemId, parseInt(e.target.value) || 0)}
                disabled={readOnly}
              />
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleItemChange(itemId, 0)}
                  className="p-1 rounded hover:bg-accent text-destructive"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="flex items-center gap-2 pt-2">
              <input
                type="text"
                value={newItemId}
                onChange={(e) => setNewItemId(e.target.value)}
                placeholder="Custom item ID (e.g., character_legendary_skin)"
                className="flex-1 min-w-0 rounded border border-border bg-background px-3 py-2 text-sm"
                list="item-suggestions"
              />
              <datalist id="item-suggestions">
                {COMMON_ITEMS.map((item) => <option key={item} value={item} />)}
              </datalist>
              <button type="button" onClick={addCustomItem} className="px-3 py-2 text-sm font-medium text-primary-foreground bg-primary rounded hover:bg-primary/90">
                <Plus className="h-3.5 w-3.5 mr-1" /> Add
              </button>
            </div>
          )}
        </div>
      </RewardSection>

      <RewardSection
        title="Energy Refills"
        icon={BatteryIcon}
        iconColor="text-rose-400"
        expanded={expandedSections.energies}
        onToggle={() => toggleSection("energies")}
        readOnly={readOnly}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {ENERGY_TYPES.map((e) => (
            <div key={e} className="flex items-center gap-2 p-3 rounded-lg border border-border bg-background/50">
              <BatteryIcon className="h-4 w-4 text-rose-400" />
              <div className="flex-1 min-w-0">
                <label className="text-xs font-medium text-foreground capitalize">{e}</label>
                <NumberInput
                  min={0}
                  value={energies[e] || 0}
                  onChange={(e2) => handleEnergyChange(e, parseInt(e2.target.value) || 0)}
                  disabled={readOnly}
                />
              </div>
            </div>
          ))}
        </div>
      </RewardSection>

      <RewardSection
        title="Gift Cards, Vouchers & Physical Rewards"
        icon={Gift}
        iconColor="text-fuchsia-400"
        expanded={expandedSections.gifts}
        onToggle={() => toggleSection("gifts")}
        readOnly={readOnly}
      >
        <p className="text-xs text-muted-foreground mb-3">
          Configure gift cards, voucher codes, digital assets, or physical items. These are delivered via email (Notifuse) and appear in the player's "My Rewards" history.
        </p>
        {gifts.map((gift, index) => (
          <div key={index} className="space-y-2 p-3 rounded-lg border border-border bg-background/50">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">Reward #{index + 1}</span>
              {!readOnly && (
                <button type="button" onClick={() => removeGift(index)} className="p-1 rounded hover:bg-accent text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Gift ID *</label>
                <input
                  type="text"
                  value={gift.id || ""}
                  onChange={(e) => handleGiftChange(index, "id", e.target.value)}
                  placeholder="giftcard_amazon_25"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm font-mono"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Display Name *</label>
                <input
                  type="text"
                  value={gift.name || ""}
                  onChange={(e) => handleGiftChange(index, "name", e.target.value)}
                  placeholder="$25 Amazon Gift Card"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Type *</label>
                <select
                  value={gift.type || "voucher"}
                  onChange={(e) => handleGiftChange(index, "type", e.target.value)}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  disabled={readOnly}
                >
                  {GIFT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Quantity</label>
                <NumberInput
                  min={1}
                  value={gift.quantity || 1}
                  onChange={(e) => handleGiftChange(index, "quantity", parseInt(e.target.value) || 1)}
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs text-muted-foreground">Value / Code (for vouchers)</label>
                <input
                  type="text"
                  value={gift.value || ""}
                  onChange={(e) => handleGiftChange(index, "value", e.target.value)}
                  placeholder="25 (for $25) or PROMO_CODE_123"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm font-mono"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs text-muted-foreground">Asset URL (digital content)</label>
                <input
                  type="url"
                  value={gift.assetUrl || ""}
                  onChange={(e) => handleGiftChange(index, "assetUrl", e.target.value)}
                  placeholder="https://s3.amazonaws.com/your-bucket/giftcard.html"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">CTA Button Label</label>
                <input
                  type="text"
                  value={gift.ctaLabel || ""}
                  onChange={(e) => handleGiftChange(index, "ctaLabel", e.target.value)}
                  placeholder="Claim Gift Card"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1">
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={gift.deliverEmail || false}
                    onChange={(e) => handleGiftChange(index, "deliverEmail", e.target.checked)}
                    className="rounded border-border"
                    disabled={readOnly}
                  />
                  Deliver via Email (requires Notifuse config)
                </label>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs text-muted-foreground">Description</label>
                <textarea
                  value={gift.description || ""}
                  onChange={(e) => handleGiftChange(index, "description", e.target.value)}
                  rows={2}
                  placeholder="Congratulations! Your reward is ready."
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm resize-none"
                  disabled={readOnly}
                />
              </div>
            </div>
          </div>
        ))}
        {!readOnly && (
          <div className="pt-2 border-t border-border">
            <h5 className="text-xs font-medium text-muted-foreground mb-2">Add New Gift Reward</h5>
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                type="text"
                value={newGift.id || ""}
                onChange={(e) => setNewGift({ ...newGift, id: e.target.value })}
                placeholder="Gift ID *"
                className="rounded border border-border bg-background px-2 py-1.5 text-sm font-mono"
              />
              <input
                type="text"
                value={newGift.name || ""}
                onChange={(e) => setNewGift({ ...newGift, name: e.target.value })}
                placeholder="Display Name *"
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
              <select
                value={newGift.type || "voucher"}
                onChange={(e) => setNewGift({ ...newGift, type: e.target.value as GiftReward["type"] })}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                {GIFT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <button type="button" onClick={addGift} className="mt-2 px-3 py-1.5 text-sm font-medium text-primary-foreground bg-primary rounded hover:bg-primary/90">
              <Plus className="h-3.5 w-3.5 mr-1 inline" /> Add Gift Reward
            </button>
          </div>
        )}
      </RewardSection>

      <RewardSection
        title="Modifiers (Temporary Boosts)"
        icon={Zap}
        iconColor="text-orange-400"
        expanded={expandedSections.modifiers}
        onToggle={() => toggleSection("modifiers")}
        readOnly={readOnly}
      >
        <p className="text-xs text-muted-foreground mb-3">
          Apply temporary multipliers or additions to energy regen or reward grants. Duration in seconds.
        </p>
        {(["energyModifiers", "rewardModifiers"] as const).map((type) => (
          <div key={type} className="mb-4">
            <label className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
              {type === "energyModifiers" ? <BatteryIcon className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
              {type === "energyModifiers" ? "Energy Modifiers" : "Reward Modifiers"}
            </label>
            {(type === "energyModifiers" ? energyModifiers : rewardModifiers).map((mod, index) => (
              <div key={index} className="flex items-center gap-2 p-2 rounded-lg border border-border bg-background/50 mb-2">
                <input
                  type="text"
                  value={mod.id}
                  onChange={(e) => handleModifierChange(type, index, "id", e.target.value)}
                  placeholder="Modifier ID (e.g., xp_boost_50)"
                  className="flex-1 min-w-0 rounded border border-border bg-background px-2 py-1 text-sm font-mono"
                  disabled={readOnly}
                />
                <select
                  value={mod.operator}
                  onChange={(e) => handleModifierChange(type, index, "operator", e.target.value as "add" | "multiply")}
                  className="rounded border border-border bg-background px-2 py-1 text-sm"
                  disabled={readOnly}
                >
                  <option value="multiply">× Multiply</option>
                  <option value="add">+ Add</option>
                </select>
                <NumberInput
                  min={0}
                  step={0.1}
                  value={mod.value}
                  onChange={(e) => handleModifierChange(type, index, "value", parseFloat(e.target.value) || 0)}
                  disabled={readOnly}
                />
                <NumberInput
                  min={0}
                  value={mod.durationSec}
                  onChange={(e) => handleModifierChange(type, index, "durationSec", parseInt(e.target.value) || 0)}
                  disabled={readOnly}
                />
                <span className="text-xs text-muted-foreground">sec</span>
                {!readOnly && (
                  <button type="button" onClick={() => removeModifier(type, index)} className="p-1 rounded hover:bg-accent text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            {!readOnly && (
              <button type="button" onClick={() => addModifier(type)} className="text-xs text-primary hover:underline">
                <Plus className="h-3.5 w-3.5 inline mr-1" /> Add {type === "energyModifiers" ? "Energy" : "Reward"} Modifier
              </button>
            )}
          </div>
        ))}
      </RewardSection>

      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">Raw JSON Preview (auto-generated)</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(previewJson)}
              className="px-2 py-1 text-xs rounded border border-border hover:bg-accent"
              title="Copy JSON"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <pre className="bg-zinc-900/50 rounded p-3 text-xs font-mono text-zinc-100 overflow-x-auto max-h-64">{previewJson || "{}"}</pre>
      </div>
    </div>
  );
}

function RewardSection({
  title,
  icon: Icon,
  iconColor,
  expanded,
  onToggle,
  readOnly,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  expanded: boolean;
  onToggle: () => void;
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-3 bg-background/50 hover:bg-background/80 text-left"
      >
        <Icon className={cn("h-4 w-4", iconColor)} />
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded && <div className="p-4">{children}</div>}
    </div>
  );
}