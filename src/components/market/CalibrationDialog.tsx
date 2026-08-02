// Calibration as a dialog inside the Breakout section.
import { HudModal } from "@/components/hud/HudModal";
import Calibration from "@/routes/market/Calibration";

export function CalibrationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <HudModal open={open} onClose={() => onOpenChange(false)} width={1200} title="Model Calibration Lab">
      <Calibration />
    </HudModal>
  );
}

export default CalibrationDialog;
