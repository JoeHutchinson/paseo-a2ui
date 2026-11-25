import { Icon, Markdown, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useContext, useRef, useState, type ReactNode } from "react";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
  type DimensionValue,
  type FlexStyle,
  type ImageResizeMode,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { evaluateChecks, toBool, toText, tryResolve, type EvalScope } from "../shared/expr";
import { getAt, joinPath } from "../shared/pointer";
import type { A2uiComponent } from "../shared/protocol";
import { TextColorContext, TriggerContext, useSurface } from "./context";
import { ICONS, svgFromPath } from "./icons";

const MAX_DEPTH = 32;

interface NodeProps {
  id: string;
  scope: EvalScope;
  depth: number;
  /** Component ids on the path from the root, to stop reference cycles. */
  ancestry: readonly string[];
}

export function Node({ id, scope, depth, ancestry }: NodeProps) {
  const { snapshot } = useSurface();
  const component = snapshot.components[id];
  if (!component) return <Placeholder text={`Loading ${id}…`} />;
  if (depth > MAX_DEPTH || ancestry.includes(id)) {
    return <Placeholder text={`Skipped ${id}: nesting too deep or cyclic`} />;
  }
  const next = { scope, depth: depth + 1, ancestry: [...ancestry, id] };
  const Impl = IMPLEMENTATIONS[component.component];
  const body = Impl ? (
    <Impl component={component} {...next} />
  ) : (
    <Placeholder text={`Unsupported component ${component.component}`} />
  );

  const a11y = component["@accessibility"] as Record<string, unknown> | undefined;
  const weight = typeof component.weight === "number" ? component.weight : undefined;
  if (!a11y && weight === undefined) return body;
  return (
    <View
      style={weight !== undefined ? { flexGrow: weight, flexShrink: 1, flexBasis: 0, minWidth: 0 } : undefined}
      accessibilityLabel={a11y ? toText(tryResolve(a11y.label, scope)) || undefined : undefined}
      accessibilityHint={a11y ? toText(tryResolve(a11y.description, scope)) || undefined : undefined}
      accessibilityElementsHidden={a11y?.hidden === true}
      importantForAccessibility={a11y?.hidden === true ? "no-hide-descendants" : "auto"}
      accessibilityLiveRegion={a11y?.live === "assertive" ? "assertive" : a11y?.live === "polite" ? "polite" : undefined}
    >
      {body}
    </View>
  );
}

interface ImplProps {
  component: A2uiComponent;
  scope: EvalScope;
  depth: number;
  ancestry: readonly string[];
}

function Placeholder({ text }: { text: string }) {
  const { theme } = useSurface();
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>{text}</Text>;
}

function str(value: unknown, scope: EvalScope): string {
  return toText(tryResolve(value, scope, ""));
}

/** Renders static children, or one copy of a template per item of a bound array. */
function Children({ component, scope, depth, ancestry, prop = "children" }: ImplProps & { prop?: string }) {
  const { data } = useSurface();
  const children = component[prop];
  if (Array.isArray(children)) {
    return (
      <>
        {children.map((child, i) =>
          typeof child === "string" ? <Node key={`${child}:${i}`} id={child} scope={scope} depth={depth} ancestry={ancestry} /> : null,
        )}
      </>
    );
  }
  if (children && typeof children === "object") {
    const { componentId, path } = children as { componentId?: unknown; path?: unknown };
    if (typeof componentId !== "string" || typeof path !== "string") return null;
    const absolute = joinPath(scope.scope, path);
    const list = getAt(data, absolute);
    if (!Array.isArray(list)) return null;
    return (
      <>
        {list.map((_, index) => (
          <Node
            key={`${componentId}:${index}`}
            id={componentId}
            scope={{ ...scope, scope: `${absolute === "/" ? "" : absolute}/${index}`, index }}
            depth={depth}
            ancestry={ancestry}
          />
        ))}
      </>
    );
  }
  return null;
}

function childNode(props: ImplProps, key: string): ReactNode {
  const id = props.component[key];
  return typeof id === "string" ? <Node id={id} scope={props.scope} depth={props.depth} ancestry={props.ancestry} /> : null;
}

const JUSTIFY: Record<string, FlexStyle["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
  stretch: "space-between",
};
const ALIGN: Record<string, FlexStyle["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

function Flex(props: ImplProps & { direction: "row" | "column" }) {
  const { layout } = useSurface();
  const justify = JUSTIFY[String(props.component.justify)] ?? "flex-start";
  const align = ALIGN[String(props.component.align)] ?? "stretch";
  return (
    <View
      style={{
        flexDirection: props.direction,
        justifyContent: justify,
        alignItems: align,
        gap: layout.compact ? 8 : 10,
        flexWrap: props.direction === "row" && layout.compact ? "wrap" : "nowrap",
      }}
    >
      <Children {...props} />
    </View>
  );
}

const MARKDOWN = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)|\*\*|__|`|\[[^\]]+\]\(/;

function TextImpl({ component, scope }: ImplProps) {
  const { theme } = useSurface();
  const override = useContext(TextColorContext);
  const text = str(component.text, scope);
  const caption = component.variant === "caption";
  if (!override && !caption && MARKDOWN.test(text)) return <Markdown>{text}</Markdown>;
  const style: TextStyle = {
    color: override ?? (caption ? theme.colors.foregroundMuted : theme.colors.foreground),
    fontSize: caption ? 12 : 14,
    lineHeight: caption ? 16 : 20,
    fontWeight: override ? "600" : undefined,
  };
  return <Text style={style}>{text}</Text>;
}

const IMAGE_SIZE: Record<string, { width?: DimensionValue; height: number; radius?: number }> = {
  icon: { width: 24, height: 24 },
  avatar: { width: 40, height: 40, radius: 20 },
  smallFeature: { width: 80, height: 80, radius: 8 },
  mediumFeature: { width: 160, height: 120, radius: 8 },
  largeFeature: { width: "100%", height: 220, radius: 8 },
  header: { width: "100%", height: 160, radius: 8 },
};
const FIT: Record<string, ImageResizeMode> = {
  contain: "contain",
  cover: "cover",
  fill: "stretch",
  none: "center",
  scaleDown: "contain",
};

function safeMediaUrl(url: string): string | null {
  return /^(https:|data:image\/)/i.test(url) ? url : null;
}

function ImageImpl({ component, scope }: ImplProps) {
  const url = safeMediaUrl(str(component.url, scope));
  const description = str(component.description, scope);
  const size = IMAGE_SIZE[String(component.variant)] ?? IMAGE_SIZE.mediumFeature;
  if (!url) return <Placeholder text="Image unavailable" />;
  return (
    <Image
      source={{ uri: url }}
      accessibilityLabel={description || undefined}
      resizeMode={FIT[String(component.fit)] ?? "stretch"}
      style={{ width: size.width, height: size.height, borderRadius: size.radius ?? 0 }}
    />
  );
}

function IconImpl({ component, scope }: ImplProps) {
  const { theme } = useSurface();
  const override = useContext(TextColorContext);
  const color = override ?? theme.colors.foreground;
  const raw = component.name;
  if (raw && typeof raw === "object" && "svgPath" in raw) {
    const path = str((raw as { svgPath: unknown }).svgPath, scope);
    return <Icon icon={{ svg: svgFromPath(path) }} size={20} color={color} />;
  }
  const name = str(raw, scope);
  return <Icon name={ICONS[name] ?? "Circle"} size={20} color={color} />;
}

function MediaLink({ component, scope, kind }: ImplProps & { kind: "Video" | "Audio" }) {
  const { theme } = useSurface();
  const url = safeMediaUrl(str(component.url, scope));
  const description = str(component.description, scope);
  return (
    <Pressable
      accessibilityRole="link"
      disabled={!url}
      onPress={() => url && void Linking.openURL(url)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Icon name={kind === "Video" ? "Film" : "Music"} size={18} color={theme.colors.foreground} />
      <Text style={{ color: theme.colors.foreground, flexShrink: 1 }} numberOfLines={1}>
        {description || `Open ${kind.toLowerCase()}`}
      </Text>
    </Pressable>
  );
}

function ListImpl(props: ImplProps) {
  const horizontal = props.component.direction === "horizontal";
  const align = ALIGN[String(props.component.align)] ?? "stretch";
  if (horizontal) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", gap: 10, alignItems: align }}>
          <Children {...props} />
        </View>
      </ScrollView>
    );
  }
  return (
    <View style={{ gap: 8, alignItems: align }}>
      <Children {...props} />
    </View>
  );
}

function CardImpl(props: ImplProps) {
  const { theme, layout } = useSurface();
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: layout.compact ? 12 : 16,
        gap: 8,
      }}
    >
      {childNode(props, "child")}
    </View>
  );
}

function DividerImpl({ component }: ImplProps) {
  const { theme } = useSurface();
  const vertical = component.axis === "vertical";
  return (
    <View
      style={
        vertical
          ? { width: 1, alignSelf: "stretch", backgroundColor: theme.colors.border }
          : { height: 1, alignSelf: "stretch", backgroundColor: theme.colors.border, marginVertical: 4 }
      }
    />
  );
}

function TabsImpl(props: ImplProps) {
  const { theme } = useSurface();
  const [active, setActive] = useState(0);
  const tabs = Array.isArray(props.component.tabs)
    ? (props.component.tabs as Array<{ title?: unknown; child?: unknown }>)
    : [];
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <View style={{ gap: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: theme.colors.border }}>
          {tabs.map((tab, i) => {
            const selected = i === active;
            return (
              <Pressable
                key={i}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setActive(i)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderBottomWidth: 2,
                  borderColor: selected ? theme.colors.accent : "transparent",
                }}
              >
                <Text style={{ color: selected ? theme.colors.foreground : theme.colors.foregroundMuted, fontWeight: selected ? "600" : "400" }}>
                  {toText(tryResolve(tab.title, props.scope, ""))}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {current && typeof current.child === "string" ? (
        <Node id={current.child} scope={props.scope} depth={props.depth} ancestry={props.ancestry} />
      ) : null}
    </View>
  );
}

function ModalImpl(props: ImplProps) {
  const { snapshot } = useSurface();
  const [open, setOpen] = useState(false);
  const triggerId = props.component.trigger;
  const triggerComponent = typeof triggerId === "string" ? snapshot.components[triggerId] : undefined;
  const title =
    triggerComponent?.component === "Button" && typeof triggerComponent.child === "string"
      ? toText(tryResolve(snapshot.components[triggerComponent.child]?.text, props.scope, ""))
      : "";
  const trigger = childNode(props, "trigger");
  return (
    <>
      <TriggerContext.Provider value={() => setOpen(true)}>
        {triggerComponent?.component === "Button" ? (
          trigger
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
            {trigger}
          </Pressable>
        )}
      </TriggerContext.Provider>
      <Modal title={title || "Details"} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <TriggerContext.Provider value={null}>{childNode(props, "content")}</TriggerContext.Provider>
        </Modal.Content>
      </Modal>
    </>
  );
}

function ButtonImpl(props: ImplProps) {
  const { theme, dispatch, data, sending } = useSurface();
  const openModal = useContext(TriggerContext);
  const scope = { ...props.scope, data };
  const failure = evaluateChecks(props.component["@checks"], scope);
  const variant = String(props.component.variant ?? "default");
  const action = props.component.action as { event?: { name?: unknown } } | undefined;
  const eventName = typeof action?.event?.name === "string" ? action.event.name : null;
  const busy = eventName !== null && sending === eventName;
  const disabled = !openModal && (failure !== undefined || busy);
  const primary = variant === "primary";
  const container: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: variant === "borderless" ? 4 : 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: primary || variant === "borderless" ? 0 : 1,
    borderColor: theme.colors.border,
    backgroundColor: primary ? theme.colors.accent : variant === "borderless" ? "transparent" : theme.colors.surface2,
    opacity: disabled ? 0.5 : 1,
    alignSelf: "flex-start",
  };
  const textColor = primary ? theme.colors.accentForeground : variant === "borderless" ? theme.colors.accent : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      accessibilityHint={failure?.message}
      disabled={disabled}
      onPress={() => (openModal ? openModal() : void dispatch(props.component, scope))}
      style={({ pressed }) => [container, pressed && !disabled ? { opacity: 0.75 } : null]}
    >
      <TextColorContext.Provider value={textColor}>{childNode(props, "child")}</TextColorContext.Provider>
    </Pressable>
  );
}

function FieldLabel({ text }: { text: string }) {
  const { theme } = useSurface();
  if (!text) return null;
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 4 }}>{text}</Text>;
}

function FieldError({ message }: { message?: string }) {
  const { theme } = useSurface();
  if (!message) return null;
  return <Text style={{ color: theme.colors.statusDanger, fontSize: 12, marginTop: 4 }}>{message}</Text>;
}

function boundPath(value: unknown, scope: EvalScope): string | null {
  if (value && typeof value === "object" && typeof (value as { "@path"?: unknown })["@path"] === "string") {
    return joinPath(scope.scope, (value as { "@path": string })["@path"]);
  }
  return null;
}

function useField(props: ImplProps) {
  const surface = useSurface();
  const scope = { ...props.scope, data: surface.data };
  const path = boundPath(props.component.value, scope);
  const value = tryResolve(props.component.value, scope);
  const [touched, setTouched] = useState(false);
  const failure = evaluateChecks(props.component["@checks"], scope);
  return {
    surface,
    scope,
    value,
    label: toText(tryResolve(props.component.label, scope, "")),
    readOnly: path === null,
    error: touched ? failure?.message : undefined,
    touch: () => setTouched(true),
    set: (next: unknown) => {
      if (path) surface.setValue(path, next as never);
      setTouched(true);
    },
  };
}

function inputStyle(theme: ReturnType<typeof useSurface>["theme"], multiline: boolean): TextStyle {
  return {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: multiline ? 88 : undefined,
    textAlignVertical: multiline ? "top" : "center",
  };
}

function TextFieldImpl(props: ImplProps) {
  const field = useField(props);
  const { theme } = field.surface;
  const variant = String(props.component.variant ?? "shortText");
  const multiline = variant === "longText";
  return (
    <View>
      <FieldLabel text={field.label} />
      <TextInput
        value={toText(field.value)}
        editable={!field.readOnly}
        onChangeText={field.set}
        onBlur={field.touch}
        placeholder={toText(tryResolve(props.component.placeholder, field.scope, "")) || undefined}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={multiline}
        secureTextEntry={variant === "obscured"}
        keyboardType={variant === "number" ? "decimal-pad" : "default"}
        accessibilityLabel={field.label || undefined}
        style={inputStyle(theme, multiline)}
      />
      <FieldError message={field.error} />
    </View>
  );
}

function Box({ checked, round }: { checked: boolean; round?: boolean }) {
  const { theme } = useSurface();
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: round ? 9 : 4,
        borderWidth: 1.5,
        borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted,
        backgroundColor: checked ? theme.colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked ? <Icon name={round ? "Dot" : "Check"} size={14} color={theme.colors.accentForeground} /> : null}
    </View>
  );
}

function CheckBoxImpl(props: ImplProps) {
  const field = useField(props);
  const checked = toBool(field.value);
  return (
    <View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: field.readOnly }}
        disabled={field.readOnly}
        onPress={() => field.set(!checked)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
      >
        <Box checked={checked} />
        <Text style={{ color: field.surface.theme.colors.foreground, flexShrink: 1 }}>{field.label}</Text>
      </Pressable>
      <FieldError message={field.error} />
    </View>
  );
}

function ChoicePickerImpl(props: ImplProps) {
  const field = useField(props);
  const { theme } = field.surface;
  const [filter, setFilter] = useState("");
  const multiple = props.component.variant === "multipleSelection";
  const chips = props.component.displayStyle === "chips";
  const selected = Array.isArray(field.value) ? field.value.map(toText) : field.value == null || field.value === "" ? [] : [toText(field.value)];
  const options = (Array.isArray(props.component.options) ? props.component.options : [])
    .map((o) => o as { label?: unknown; value?: unknown })
    .map((o) => ({ value: toText(o.value), label: toText(tryResolve(o.label, field.scope, "")) || toText(o.value) }))
    .filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (value: string) => {
    if (!multiple) return field.set([value]);
    field.set(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  return (
    <View>
      <FieldLabel text={field.label} />
      {props.component.filterable === true ? (
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[inputStyle(theme, false), { marginBottom: 6 }]}
        />
      ) : null}
      <View style={chips ? { flexDirection: "row", flexWrap: "wrap", gap: 6 } : { gap: 2 }}>
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <Pressable
              key={option.value}
              accessibilityRole={multiple ? "checkbox" : "radio"}
              accessibilityState={{ checked: on, disabled: field.readOnly }}
              disabled={field.readOnly}
              onPress={() => toggle(option.value)}
              style={
                chips
                  ? {
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: on ? theme.colors.accent : theme.colors.border,
                      backgroundColor: on ? theme.colors.accent : theme.colors.surface2,
                    }
                  : { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 }
              }
            >
              {chips ? null : <Box checked={on} round={!multiple} />}
              <Text style={{ color: chips && on ? theme.colors.accentForeground : theme.colors.foreground }}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <FieldError message={field.error} />
    </View>
  );
}

/**
 * Paseo's phone layout opens a side panel on any horizontal swipe past ~15px, and plugins cannot
 * claim that gesture, so long slider drags can lose to it on iOS and Android. The step buttons and
 * tap-to-jump on the track never move far enough to trigger it.
 */
function StepButton({ icon, label, disabled, onPress }: { icon: string; label: string; disabled: boolean; onPress(): void }) {
  const { theme } = useSurface();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
    </Pressable>
  );
}

function SliderImpl(props: ImplProps) {
  const field = useField(props);
  const { theme } = field.surface;
  const min = typeof props.component.min === "number" ? props.component.min : 0;
  const max = typeof props.component.max === "number" ? props.component.max : 100;
  const steps = typeof props.component.steps === "number" && props.component.steps > 0 ? props.component.steps : 0;
  const width = useRef(0);
  const raw = Number(field.value);
  const value = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min;
  const fraction = max > min ? (value - min) / (max - min) : 0;
  const decimals = steps ? Math.max(0, -Math.floor(Math.log10((max - min) / steps))) : Number.isInteger(max - min) ? 0 : 2;
  const quantise = (f: number) => {
    const clamped = Math.min(1, Math.max(0, f));
    const snapped = steps ? Math.round(clamped * steps) / steps : clamped;
    return Number((min + snapped * (max - min)).toFixed(Math.min(decimals, 6)));
  };
  const nudge = (direction: 1 | -1) => {
    const step = steps ? (max - min) / steps : (max - min) / 20;
    field.set(Math.min(max, Math.max(min, Number((value + direction * step).toFixed(6)))));
  };
  const origin = useRef(0);
  const fromX = (x: number) => {
    if (width.current > 0 && !field.readOnly) field.set(quantise(x / width.current));
  };
  // locationX is only reliable on the initial press (some platforms report it relative to whatever
  // is under the pointer during a drag), so remember the track's page offset and use pageX after.
  const onGrant = (e: { nativeEvent: { locationX: number; pageX: number } }) => {
    origin.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
    fromX(e.nativeEvent.locationX);
  };
  const onMove = (e: { nativeEvent: { pageX: number } }) => fromX(e.nativeEvent.pageX - origin.current);
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <FieldLabel text={field.label} />
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{value}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <StepButton icon="Minus" label="Decrease" disabled={field.readOnly || value <= min} onPress={() => nudge(-1)} />
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={field.label || undefined}
        accessibilityValue={{ min, max, now: value }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 1 : -1)}
        onLayout={(e) => {
          width.current = e.nativeEvent.layout.width;
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        style={{ height: 36, justifyContent: "center", flex: 1 }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2 }} pointerEvents="none">
          <View style={{ width: `${fraction * 100}%`, height: 4, borderRadius: 2, backgroundColor: theme.colors.accent }} />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: `${fraction * 100}%`,
            marginLeft: -9,
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: theme.colors.accent,
            borderWidth: 2,
            borderColor: theme.colors.surface0,
          }}
        />
      </View>
      <StepButton icon="Plus" label="Increase" disabled={field.readOnly || value >= max} onPress={() => nudge(1)} />
      </View>
      <FieldError message={field.error} />
    </View>
  );
}

function DateTimeImpl(props: ImplProps) {
  const field = useField(props);
  const { theme } = field.surface;
  // Catalog defaults are false for both; with neither set, fall back to a date field.
  const enableTime = props.component.enableTime === true;
  const enableDate = props.component.enableDate === true || !enableTime;
  const placeholder = enableDate && enableTime ? "YYYY-MM-DDTHH:MM" : enableTime ? "HH:MM" : "YYYY-MM-DD";
  const text = toText(field.value);
  const valid =
    !text ||
    (enableDate && enableTime
      ? /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)
      : enableTime
        ? /^\d{2}:\d{2}(:\d{2})?$/.test(text)
        : /^\d{4}-\d{2}-\d{2}$/.test(text));
  const now = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    field.set(enableDate && enableTime ? `${date}T${time}` : enableTime ? time : date);
  };
  return (
    <View>
      <FieldLabel text={field.label} />
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <TextInput
          value={text}
          editable={!field.readOnly}
          onChangeText={field.set}
          onBlur={field.touch}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          style={[inputStyle(theme, false), { flex: 1, minWidth: 0 }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Use current date and time" onPress={now} disabled={field.readOnly}>
          <Icon name={enableTime && !enableDate ? "Clock" : "CalendarDays"} size={20} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <FieldError message={valid ? field.error : `Use the format ${placeholder}.`} />
    </View>
  );
}

const IMPLEMENTATIONS: Record<string, (props: ImplProps) => ReactNode> = {
  Text: TextImpl,
  Image: ImageImpl,
  Icon: IconImpl,
  Video: (p) => <MediaLink {...p} kind="Video" />,
  AudioPlayer: (p) => <MediaLink {...p} kind="Audio" />,
  Row: (p) => <Flex {...p} direction="row" />,
  Column: (p) => <Flex {...p} direction="column" />,
  List: ListImpl,
  Card: CardImpl,
  Tabs: TabsImpl,
  Divider: DividerImpl,
  Modal: ModalImpl,
  Button: ButtonImpl,
  TextField: TextFieldImpl,
  CheckBox: CheckBoxImpl,
  ChoicePicker: ChoicePickerImpl,
  Slider: SliderImpl,
  DateTimeInput: DateTimeImpl,
};
