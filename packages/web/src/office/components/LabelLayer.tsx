import { layoutLabels, labelFontPx, type LabelInput, type LabelSide, type StageSize } from '../labelLayout';

/**
 * Every character's label, drawn in one layer above the room so no desk or plant can cover the text, and laid out so
 * no two labels overlap. A label that had to move keeps a leader line to its character's feet; the line starts on its
 * own box's border and, by the layout's placement rule, enters no other box on the way.
 */
export default function LabelLayer({ stage, inputs, prefer }: { stage: StageSize; /** Label anchors in percent of the stage (the Pixi stage passes its projected feet). */ inputs: LabelInput[]; prefer?: LabelSide }) {
  const boxes = layoutLabels(inputs, stage, prefer);
  if (boxes.length === 0) return null;
  const fontPx = labelFontPx(stage.width);
  return (
    <div className="office-labels" aria-hidden="true">
      <svg className="office-label-leaders" viewBox={`0 0 ${stage.width} ${stage.height}`} width={stage.width} height={stage.height}>
        {boxes.map((box) => (
          <line key={box.id} data-label-leader={box.id}
            x1={box.leaderX} y1={box.leaderY} x2={box.anchorX} y2={box.anchorY} />
        ))}
      </svg>
      {boxes.map((box) => (
        <span key={box.id} className={`office-char-label${box.className ? ` ${box.className}` : ''}`} data-label-for={box.id}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, fontSize: fontPx }}>
          {box.text}
        </span>
      ))}
    </div>
  );
}
