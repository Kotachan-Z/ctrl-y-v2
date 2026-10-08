import { Link } from "react-router-dom";

import { cardClass } from "../../styles/shared";

export default function LinkCard({
  to,
  icon,
  title,
  description,
}: {
  to: string;
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className={`${cardClass} flex items-center gap-4 transition-shadow hover:shadow-xl`}
    >
      <img
        src={icon}
        alt=""
        width="48"
        height="48"
        className="h-11 w-11 shrink-0 object-contain sm:h-12 sm:w-12"
      />
      <div>
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="text-sm text-[#5C410E]/70">{description}</p>
      </div>
    </Link>
  );
}
