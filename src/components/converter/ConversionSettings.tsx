'use client';

import { Settings, Video } from 'lucide-react';
import type { QualityPreset, ConversionSettings as SettingsType } from '@/types/converter';
import { QUALITY_PRESETS } from '@/types/converter';

interface ConversionSettingsProps {
  settings: SettingsType;
  onSettingsChange: (settings: SettingsType) => void;
}

export function ConversionSettings({ settings, onSettingsChange }: ConversionSettingsProps) {
  const handleQualityChange = (quality: QualityPreset) => {
    onSettingsChange({ ...settings, quality });
  };

  return (
    <div className="bg-[#F9FAFB] rounded-[10px] p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Settings className="w-4 h-4 text-[#6B7280]" />
        <h3 className="text-sm font-medium text-[#374151]">Dönüşüm Ayarları</h3>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-[#6B7280] mb-2">
            Video Kalitesi
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(QUALITY_PRESETS) as QualityPreset[]).map((preset) => (
              <button
                key={preset}
                onClick={() => handleQualityChange(preset)}
                className={`
                  py-2 px-3 rounded-lg text-xs font-medium transition-all
                  ${settings.quality === preset
                    ? 'bg-[#376BFC] text-white'
                    : 'bg-white text-[#374151] border border-[#E5E7EB] hover:border-[#376BFC]'
                  }
                `}
              >
                {QUALITY_PRESETS[preset].label}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-2 border-t border-[#E5E7EB]">
          <div className="flex items-center gap-2 text-xs text-[#6B7280]">
            <Video className="w-3.5 h-3.5" />
            <span>
              <span className="font-medium text-[#374151]">H.264</span> – Telefonlar, 
              bilgisayarlar ve sosyal medya platformlarıyla uyumlu
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
