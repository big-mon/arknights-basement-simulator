import { Check } from "lucide-react";
import { facilityLabels, productLabels, uiText } from "../i18n";
import type { Assignment, FacilityPlan, FacilitySlot, LanguageCode } from "../types";

export function FacilityPlanCard({
  facilityPlan,
  assignments,
  language,
  operatorNameById
}: {
  facilityPlan: FacilityPlan;
  assignments: Assignment[];
  language: LanguageCode;
  operatorNameById: (operatorId: string) => string;
}) {
  const expectedEfficiency = assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);
  const text = uiText[language];

  return (
    <article className={`plan-card plan-card-${facilityPlan.facility.type}`}>
      <div className="plan-card-heading">
        <div>
          <h4>{formatFacilityName(facilityPlan.facility, language)}</h4>
          {showsTargetProduct(facilityPlan.facility) ? (
            <p className="plan-card-product">{productLabels[language][facilityPlan.facility.product]}</p>
          ) : null}
        </div>
        <strong>+{Math.round(expectedEfficiency * 100)}%</strong>
      </div>
      {assignments.length ? (
        <ul className="assignment-list">
          {assignments.map((assignment) => (
            <li key={`${assignment.facilityId}-${assignment.operatorId}`}>
              <Check size={16} />
              <span>
                {operatorNameById(assignment.operatorId)}
                <small>{assignment.reason}</small>
              </span>
              <b>{assignment.score.toFixed(1)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="alternatives">{text.plan.noCandidates}</p>
      )}
    </article>
  );
}

function showsTargetProduct(facility: FacilitySlot) {
  return facility.type === "factory" || facility.type === "trading";
}

function formatFacilityName(facility: FacilitySlot, language: LanguageCode) {
  const baseName = facilityLabels[language][facility.type];

  if (facility.type === "factory" || facility.type === "trading" || facility.type === "power") {
    const roomNumber = Number(facility.id.split("-").at(-1));
    const suffix = Number.isFinite(roomNumber) ? String.fromCharCode(64 + roomNumber) : "";
    return suffix ? `${baseName} ${suffix}` : baseName;
  }

  return baseName;
}
