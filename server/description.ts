export const RENDER_TOOL_DESCRIPTION = `Render interactive UI for the user in the Paseo chat (desktop, web and mobile) using A2UI v1.0 messages with the basic catalog. Use it when a form, choice, table-like list, card or dashboard communicates better than prose, or when you need structured input from the user. The UI appears inline in the conversation.

Input: {"messages": [ ...A2UI messages... ]}. Each message has exactly one of:
- {"createSurface": {"surfaceId", "components"?: [...], "dataModel"?: {...}, "sendDataModel"?: bool}}
- {"updateComponents": {"surfaceId", "components": [...]}}   (adds or replaces components by id)
- {"updateDataModel": {"surfaceId", "path"?: "/json/pointer", "value"}}   (value null deletes)
- {"deleteSurface": {"surfaceId"}}
Surface ids are yours to choose; reuse one to update a surface in place instead of creating a new one.

Components are a flat list: {"id": "snake_case_id", "component": "<Type>", ...props}. Exactly one has id "root". Containers reference children by id.
Dynamic values: a literal, {"@path": "/abs/pointer"} (or a relative path inside list templates), or {"@call": "fn", "args": {...}}.
Text interpolation: {"@call": "formatString", "args": {"value": "Hello \${/user/name}, total \${formatCurrency(value:\${/total}, currency:'USD')}"}}.

Components (basic catalog):
- Text {text, variant?: body|caption}. Text supports simple Markdown (headings, bold, lists, links).
- Image {url, description?, fit?, variant?: icon|avatar|smallFeature|mediumFeature|largeFeature|header}
- Icon {name}: accountCircle add arrowBack arrowForward attachFile calendarToday call camera check close delete download edit event error favorite folder help home info locationOn lock lockOpen mail menu moreVert moreHoriz notifications pause payment person phone photo play print refresh search send settings share shoppingCart star starOff stop upload visibility visibilityOff warning
- Row / Column {children, justify?: start|center|end|spaceBetween|spaceAround|spaceEvenly|stretch, align?: start|center|end|stretch}
- List {children, direction?: vertical|horizontal}
  children is ["id", ...] or a template {"componentId": "item_tpl", "path": "/items"}; inside the template, paths without a leading "/" resolve against each item.
- Card {child}; Divider {axis?}; Tabs {tabs: [{title, child}]}; Modal {trigger, content}
- Button {child, variant?: default|primary|borderless, action}
  action: {"event": {"name": "submit_form", "userMessage"?: "...", "context": {"email": {"@path": "/form/email"}}}} sends the event to you; or {"functionCall": {"@call": "openUrl", "args": {"url": "https://..."}}}.
- TextField {label, value: {"@path"}, placeholder?, variant?: shortText|longText|number|obscured}
- CheckBox {label, value: {"@path"}}
- ChoicePicker {label?, options: [{label, value}], value: {"@path"} (string list), variant?: mutuallyExclusive|multipleSelection, displayStyle?: checkbox|chips}
- Slider {label?, min?, max, steps?, value: {"@path"}}. steps is the NUMBER OF DIVISIONS, not the step size: whole numbers from 1 to 50 need steps: 49; omit it for a continuous slider.
- DateTimeInput {label?, value: {"@path"}, enableDate?, enableTime?}  (ISO 8601 strings)
Any component accepts "weight" (flex grow inside Row/Column). Inputs and Buttons accept "@checks": [{"condition": {"@call": "required"|"email"|"regex"|"length"|"numeric", "args": {...}}, "message": "..."}]; a Button with a failing check is disabled.
Functions: required email regex length numeric and or not formatString formatNumber formatCurrency formatDate pluralize openUrl.

Inputs write to the data model locally; nothing is sent until the user presses a Button with an event action. You then receive a user message containing an <a2ui-action> JSON block with the event name, surfaceId, sourceComponentId and resolved context (plus the whole data model when the surface has sendDataModel: true). Put every input you need into the action context or set sendDataModel.

Example:
{"messages": [{"version": "1.0", "createSurface": {"surfaceId": "deploy_choice", "dataModel": {"env": ["test"]}, "components": [
 {"id": "root", "component": "Card", "child": "col"},
 {"id": "col", "component": "Column", "children": ["title", "picker", "go"]},
 {"id": "title", "component": "Text", "text": "### Where should I deploy?"},
 {"id": "picker", "component": "ChoicePicker", "options": [{"label": "Test", "value": "test"}, {"label": "UAT", "value": "uat"}], "value": {"@path": "/env"}},
 {"id": "go_label", "component": "Text", "text": "Deploy"},
 {"id": "go", "component": "Button", "variant": "primary", "child": "go_label", "action": {"event": {"name": "deploy", "context": {"env": {"@path": "/env"}}}}}
]}}]}

The tool result lists errors (nothing applied for that message) and warnings (rendered, but fix them).`;
