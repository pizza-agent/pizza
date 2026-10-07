export function BrandIcon({
	size = 28,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 25 25"
			xmlns="http://www.w3.org/2000/svg"
			shapeRendering="crispEdges"
			className={className}
			role="img"
			aria-label="pizza"
		>
			{/* Pixel-art pizza slice — matches the desktop app icon (icons/icon.png, 25x25 grid) */}
			<g fill="#D4A373">
				{/* Crust */}
				<rect x="0" y="0" width="25" height="1" />
				<rect x="0" y="1" width="25" height="1" />
				<rect x="1" y="2" width="23" height="1" />
				<rect x="1" y="3" width="23" height="1" />
			</g>
			<g fill="#F9C74F">
				{/* Cheese */}
				<rect x="2" y="4" width="21" height="1" />
				<rect x="2" y="5" width="21" height="1" />
				<rect x="3" y="6" width="11" height="1" />
				<rect x="15" y="6" width="7" height="1" />
				<rect x="3" y="7" width="5" height="1" />
				<rect x="9" y="7" width="4" height="1" />
				<rect x="16" y="7" width="6" height="1" />
				<rect x="4" y="8" width="3" height="1" />
				<rect x="10" y="8" width="4" height="1" />
				<rect x="15" y="8" width="6" height="1" />
				<rect x="4" y="9" width="2" height="1" />
				<rect x="11" y="9" width="5" height="1" />
				<rect x="17" y="9" width="4" height="1" />
				<rect x="5" y="10" width="2" height="1" />
				<rect x="10" y="10" width="5" height="1" />
				<rect x="18" y="10" width="2" height="1" />
				<rect x="5" y="11" width="3" height="1" />
				<rect x="9" y="11" width="5" height="1" />
				<rect x="19" y="11" width="1" height="1" />
				<rect x="6" y="12" width="3" height="1" />
				<rect x="10" y="12" width="5" height="1" />
				<rect x="18" y="12" width="1" height="1" />
				<rect x="6" y="13" width="2" height="1" />
				<rect x="12" y="13" width="4" height="1" />
				<rect x="17" y="13" width="2" height="1" />
				<rect x="6" y="14" width="3" height="1" />
				<rect x="13" y="14" width="6" height="1" />
				<rect x="7" y="15" width="2" height="1" />
				<rect x="14" y="15" width="4" height="1" />
				<rect x="7" y="16" width="3" height="1" />
				<rect x="13" y="16" width="2" height="1" />
				<rect x="16" y="16" width="2" height="1" />
				<rect x="8" y="17" width="3" height="1" />
				<rect x="12" y="17" width="2" height="1" />
				<rect x="9" y="18" width="4" height="1" />
				<rect x="10" y="19" width="4" height="1" />
				<rect x="11" y="20" width="2" height="1" />
				<rect x="14" y="20" width="1" height="1" />
				<rect x="10" y="21" width="2" height="1" />
				<rect x="10" y="22" width="3" height="1" />
				<rect x="14" y="22" width="1" height="1" />
				<rect x="11" y="23" width="3" height="1" />
				<rect x="11" y="24" width="3" height="1" />
			</g>
			<g fill="#BC4749">
				{/* Pepperoni */}
				<rect x="8" y="7" width="1" height="1" />
				<rect x="7" y="8" width="3" height="1" />
				<rect x="6" y="9" width="5" height="1" />
				<rect x="16" y="9" width="1" height="1" />
				<rect x="7" y="10" width="3" height="1" />
				<rect x="15" y="10" width="3" height="1" />
				<rect x="8" y="11" width="1" height="1" />
				<rect x="14" y="11" width="5" height="1" />
				<rect x="15" y="12" width="3" height="1" />
				<rect x="11" y="13" width="1" height="1" />
				<rect x="16" y="13" width="1" height="1" />
				<rect x="10" y="14" width="3" height="1" />
				<rect x="9" y="15" width="5" height="1" />
				<rect x="10" y="16" width="3" height="1" />
				<rect x="15" y="16" width="1" height="1" />
				<rect x="11" y="17" width="1" height="1" />
				<rect x="14" y="17" width="3" height="1" />
				<rect x="8" y="18" width="1" height="1" />
				<rect x="13" y="18" width="5" height="1" />
				<rect x="7" y="19" width="3" height="1" />
				<rect x="14" y="19" width="3" height="1" />
				<rect x="6" y="20" width="5" height="1" />
				<rect x="15" y="20" width="1" height="1" />
				<rect x="7" y="21" width="3" height="1" />
				<rect x="8" y="22" width="1" height="1" />
			</g>
			<g fill="#43AA8B">
				{/* Basil */}
				<rect x="14" y="6" width="1" height="1" />
				<rect x="13" y="7" width="3" height="1" />
				<rect x="14" y="8" width="1" height="1" />
				<rect x="9" y="12" width="1" height="1" />
				<rect x="8" y="13" width="3" height="1" />
				<rect x="9" y="14" width="1" height="1" />
				<rect x="13" y="20" width="1" height="1" />
				<rect x="12" y="21" width="3" height="1" />
				<rect x="13" y="22" width="1" height="1" />
			</g>
		</svg>
	);
}
