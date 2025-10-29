#!/bin/bash
# One-time script to update all $2,000 monthly limit references to $500
# Run from project root: bash scripts/dev/update-spending-limit-refs.sh

echo "Updating monthly spending limit references..."
echo "From: \$2,000 (30-day rolling)"
echo "To: \$500 (calendar month)"
echo ""

# Update UI_DESIGN.md
sed -i 's/\$2,000 per month (30-day window)/\$500 per month (calendar month)/g' docs/UI_DESIGN.md
sed -i 's/\$680 \/ \$2,000/\$85 \/ \$500/g' docs/UI_DESIGN.md
sed -i 's/Current limit: \$2,000 per month/Current limit: \$500 per month/g' docs/UI_DESIGN.md
sed -i 's/• \$2,000\/month - Default (most users)/• \$500\/month - Default (see CONSTANTS.md)/g' docs/UI_DESIGN.md
sed -i 's/(min: \$100, max: \$50,000)/(min: \$20, unlimited)/g' docs/UI_DESIGN.md
sed -i 's/\$2,000\/month (user-adjustable: \$100-\$50,000)/\$500\/month (user-adjustable: \$20-unlimited, see CONSTANTS.md)/g' docs/UI_DESIGN.md
sed -i 's/"Monthly spending limit changed: \$2,000 → \$5,000"/"Monthly spending limit changed: \$500 → \$1,000"/g' docs/UI_DESIGN.md

# Update ESCROW_DESIGN.md remaining references
sed -i 's/• \$2,000\/month - Recommended default/• \$500\/month - Default (see CONSTANTS.md)/g' docs/ESCROW_DESIGN.md
sed -i 's/☑ Use \$2,000\/month (recommended)/☑ Use \$500\/month (see CONSTANTS.md)/g' docs/ESCROW_DESIGN.md
sed -i 's/monthly limit = \$2,000/monthly limit = \$500/g' docs/ESCROW_DESIGN.md
sed -i 's/\$30 < \$2,000/\$30 < \$500/g' docs/ESCROW_DESIGN.md
sed -i 's/\$65 < \$2,000/\$65 < \$500/g' docs/ESCROW_DESIGN.md
sed -i 's/\$2,025 > \$2,000/\$510 > \$500/g' docs/ESCROW_DESIGN.md
sed -i 's/Your monthly limit: \$2,000/Your monthly limit: \$500/g' docs/ESCROW_DESIGN.md
sed -i 's/\$2,000 ✓ (at limit/\$500 ✓ (at limit/g' docs/ESCROW_DESIGN.md
sed -i 's/Monthly limit: \$2,000/Monthly limit: \$500/g' docs/ESCROW_DESIGN.md

echo "✓ Updated UI_DESIGN.md"
echo "✓ Updated ESCROW_DESIGN.md"
echo ""
echo "Done! Review changes with: git diff docs/"
